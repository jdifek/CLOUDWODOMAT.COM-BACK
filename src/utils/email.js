import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendPasswordEmail = async (email, password) => {
  const mailOptions = {
    from: process.env.SMTP_USER,
    to: email,
    subject: 'Your account credentials',
    html: `
      <h2>Welcome!</h2>
      <p>Your account has been created.</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Temporary Password:</strong> ${password}</p>
      <p>Please change your password after first login.</p>
    `,
  };

  await transporter.sendMail(mailOptions);
};
