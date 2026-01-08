import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedUsers() {
  console.log('🌱 Seeding test users...');

  try {
    // Создаем обычного пользователя
    const userPassword = await bcrypt.hash('user123', 10);
    const user = await prisma.user.upsert({
      where: { email: 'user@test.com' },
      update: {},
      create: {
        email: 'user@test.com',
        passwordHash: userPassword,
        role: 'USER',
        name: 'Test',
        surname: 'User',
        phone: '+1234567890',
        company: 'Test Company',
      },
    });
    console.log('✅ User created:', user.email, '/ Password: user123');

    // Создаем админа
    const adminPassword = await bcrypt.hash('admin123', 10);
    const admin = await prisma.user.upsert({
      where: { email: 'admin@test.com' },
      update: {},
      create: {
        email: 'admin@test.com',
        passwordHash: adminPassword,
        role: 'ADMIN',
        name: 'Admin',
        surname: 'Administrator',
        phone: '+0987654321',
        company: 'Admin Corp',
      },
    });
    console.log('✅ Admin created:', admin.email, '/ Password: admin123');

    // Создаем несколько устройств для обычного пользователя
    await prisma.device.createMany({
      data: [
        { userId: user.id, name: 'Device 1', code: 'DEV-001' },
        { userId: user.id, name: 'Device 2', code: 'DEV-002' },
      ],
      skipDuplicates: true,
    });
    console.log('✅ Test devices created for user');

    console.log('\n📋 Summary:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Regular User:');
    console.log('  Email: user@test.com');
    console.log('  Password: user123');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Admin User:');
    console.log('  Email: admin@test.com');
    console.log('  Password: admin123');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('❌ Error seeding users:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

seedUsers();