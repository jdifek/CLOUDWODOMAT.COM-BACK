import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Создаём системные настройки
  console.log('📋 Creating system settings...');
  
  const basePrice = await prisma.settings.upsert({
    where: { key: 'BASE_PRICE' },
    update: { value: '1' },
    create: {
      key: 'BASE_PRICE',
      value: '1', // Цена в PLN за одно устройство в месяц
    },
  });
  
  console.log(`✅ BASE_PRICE set to: ${basePrice.value} PLN`);

  // 2. Создаём админа (если его еще нет)
  console.log('👤 Creating admin user...');
  
  const adminPassword = await bcrypt.hash('admin123', 10);
  
  const admin = await prisma.user.upsert({
    where: { email: 'admin@wodomat.com' },
    update: {},
    create: {
      email: 'admin@wodomat.com',
      passwordHash: adminPassword,
      role: 'ADMIN',
      name: 'Admin',
      surname: 'Wodomat',
      phone: '+48123456789',
      appid: '82ec629a2603b1578ba2add80e647912',
      saler: 'wodomat2025',
      company: 'Wodomat System',
    },
  });
  
  console.log(`✅ Admin user: ${admin.email} (password: admin123)`);

  // 3. Создаём тестового пользователя
  console.log('👤 Creating test user...');
  
  const userPassword = await bcrypt.hash('user123', 10);
  const testUser = await prisma.user.upsert({
    where: { email: 'user@test.com' },
    update: {},
    create: {
      email: 'user@test.com',
      passwordHash: userPassword,
      role: 'USER',
      name: 'Test',
      surname: 'User',
      phone: '+48987654321',
      company: 'Test Company',
      appid: '82ec629a2603b1578ba2add80e647912',
      saler: 'wodomat2025',
    },
  });
  console.log(`✅ Test user: ${testUser.email} (password: user123)`);

  // 4. Создаём тестовые устройства для пользователя
  console.log('📱 Creating test devices...');
  
  const device1 = await prisma.device.upsert({
    where: { code: 'DEV-001' },
    update: {},
    create: {
      userId: testUser.id,
      name: 'Wodomat #1',
      code: 'DEV-001',
    },
  });

  const device2 = await prisma.device.upsert({
    where: { code: 'DEV-002' },
    update: {},
    create: {
      userId: testUser.id,
      name: 'Wodomat #2',
      code: 'DEV-002',
    },
  });

  const device3 = await prisma.device.upsert({
    where: { code: 'DEV-003' },
    update: {},
    create: {
      userId: testUser.id,
      name: 'Wodomat #3',
      code: 'DEV-003',
    },
  });
  
  console.log(`✅ Created ${3} test devices`);

  // 5. Создаём тестовую подписку для пользователя
  console.log('💳 Creating test subscription...');
  
  const basePriceValue = parseFloat(basePrice.value);
  const devicesCount = 3;
  const subscriptionPrice = basePriceValue * devicesCount;
  
  const subscription = await prisma.subscription.upsert({
    where: { userId: testUser.id },
    update: {},
    create: {
      userId: testUser.id,
      status: 'ACTIVE',
      price: subscriptionPrice,
      devicesCount: devicesCount,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 days
    },
  });
  
  console.log(`✅ Subscription created: ${subscription.price} PLN/month (${devicesCount} devices)`);

  console.log('\n🎉 Database seed completed successfully!');
  console.log('\n📝 Summary:');
  console.log(`   - BASE_PRICE: ${basePrice.value} PLN`);
  console.log(`   - Admin: admin@wodomat.com / admin123`);
  console.log(`   - Test User: user@test.com / user123`);
  console.log(`   - Devices: ${devicesCount}`);
  console.log(`   - Subscription: ${subscription.price} PLN/month`);
}

main()
  .catch((e) => {
    console.error('❌ Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });