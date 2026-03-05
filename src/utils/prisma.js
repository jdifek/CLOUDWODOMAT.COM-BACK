import { PrismaClient } from '@prisma/client';
import os from "os";

let prisma

// Определяем тип окружения и настройки согласно документации Prisma
function getDatabaseUrl() {
  const baseUrl = process.env.DATABASE_URL
  
  if (!baseUrl) {
    throw new Error('DATABASE_URL is not defined')
  }
  
  const url = new URL(baseUrl)
  
  // Определяем количество CPU для расчета connection_limit
  const numCpus = os.cpus().length;
    const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
  
  // Для Supabase pooler (внешний connection pooler)
  if (baseUrl.includes('pooler.supabase.com')) {
    if (isServerless) {
      // Serverless + external pooler: начинаем с 1, можем увеличить
      url.searchParams.set('connection_limit', '3')
    } else {
      // Long-running + external pooler: используем формулу из документации
      const defaultPoolSize = numCpus * 2 + 1
      url.searchParams.set('connection_limit', defaultPoolSize.toString())
    }
    url.searchParams.set('pool_timeout', '20')
    url.searchParams.set('sslmode', 'require')
    return url.toString()
  }
  
  // Для прямого подключения без external pooler
  if (isServerless) {
    // Serverless без external pooler: ОБЯЗАТЕЛЬНО connection_limit=1
    url.searchParams.set('connection_limit', '1')
    url.searchParams.set('pool_timeout', '20')
  } else {
    // Long-running без external pooler: используем default или настраиваем
    const defaultPoolSize = numCpus * 2 + 1
    url.searchParams.set('connection_limit', defaultPoolSize.toString())
    url.searchParams.set('pool_timeout', '10')
  }
  
  url.searchParams.set('sslmode', 'require')
  return url.toString()
}

// Создание Prisma Client
function createPrismaClient() {
  return new PrismaClient({
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
    log: process.env.NODE_ENV === 'production' 
      ? ['error'] 
      : ['error', 'warn'],
    errorFormat: 'minimal',
  })
}

// Правильная инициализация согласно документации Prisma
const globalForPrisma = globalThis

// В development предотвращаем создание множественных экземпляров при hot reload
if (process.env.NODE_ENV !== 'production') {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient()
  }
  prisma = globalForPrisma.prisma
} else {
  // В production просто создаем один экземпляр
  prisma = createPrismaClient()
}

// Функция для безопасного выполнения запросов с retry логикой
async function executeWithRetry(operation, maxRetries = 3) {
  let lastError
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      
      // Если это ошибка connection pool timeout
      if (error.code === 'P2024') {
        console.warn(`Connection pool timeout, retry ${i + 1}/${maxRetries}`)
        
        // Ждем перед повторной попыткой
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)))
        continue
      }
      
      // Для других ошибок не повторяем
      throw error
    }
  }
  
  throw lastError
}

// Расширяем prisma клиент функцией безопасного выполнения
prisma.safeExecute = executeWithRetry

// Проверка подключения при старте (упрощенная)
async function testConnection() {
  try {
    await executeWithRetry(async () => {
      await prisma.$queryRaw`SELECT 1 as test`
    })
    console.log('✅ Database connection successful')
  } catch (error) {
    console.error('❌ Database connection failed:', error.message)
  }
}

// Тестируем подключение только один раз при старте
if (process.env.NODE_ENV !== 'test') {
  testConnection()
}

// Graceful shutdown (НЕ disconnect в long-running приложениях по умолчанию)
const shutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`)
  
  // В long-running приложениях отключаемся только при завершении процесса
  try {
    await prisma.$disconnect()
    console.log('Database disconnected')
  } catch (error) {
    console.error('Error during shutdown:', error.message)
  } finally {
    process.exit(0)
  }
}

// Обрабатываем сигналы завершения
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// НЕ отключаемся на beforeExit в long-running приложениях

export default prisma