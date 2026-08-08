const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Sends a verification OTP email with a premium dark theme.
 * @param {string} toEmail 
 * @param {string} otp 
 * @param {number} expiryMinutes 
 */
async function sendOtpEmail(toEmail, otp, expiryMinutes = 5) {
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Verify Your Email - DonotBeSolo</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Outfit:wght@300;400;600&display=swap');
      </style>
    </head>
    <body style="background-color: #0d0714; margin: 0; padding: 0; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <div style="background-color: #0d0714; color: #ffffff; padding: 40px 20px; text-align: center;">
        <div style="background-color: #0f051e; color: #ffffff; padding: 40px; border-radius: 16px; border: 2px solid #ff4da6; text-align: center; max-width: 500px; margin: 0 auto; box-shadow: 0 0 20px #8a2be2;">
          <h1 style="color: #ff4da6; text-shadow: 0 0 10px #ff4da6; margin-bottom: 20px; font-family: 'Rajdhani', sans-serif; font-size: 28px; font-weight: 700; letter-spacing: 1px;">Verify Your Email</h1>
          <p style="font-size: 16px; color: #b8b3e8; line-height: 1.6; font-weight: 300;">Welcome to <strong>DonotBeSolo</strong>. Use the security verification code below to authorize and complete your registration:</p>
          
          <div style="background: rgba(21, 13, 42, 0.85); border: 1px solid #8a2be2; border-radius: 8px; padding: 18px; font-size: 38px; font-weight: 700; letter-spacing: 8px; color: #00f0ff; text-shadow: 0 0 10px #00f0ff; margin: 30px auto; width: fit-content; font-family: monospace;">
            ${otp}
          </div>
          
          <p style="font-size: 14px; color: #ff4da6; font-weight: 400; margin: 20px 0;">This OTP code will expire in <strong>${expiryMinutes} minutes</strong>.</p>
          
          <p style="font-size: 12px; color: #6a629b; margin-top: 40px; border-top: 1px solid rgba(255, 77, 166, 0.15); padding-top: 20px; line-height: 1.5;">
            If you didn't request this email, please ignore it.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: `"DonotBeSolo Security" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: 'Verify Your Email - DonotBeSolo',
    html: emailHtml
  };

  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('[Nodemailer Error]:', error);
        reject(error);
      } else {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[OTP Email Sent] Target: ${toEmail} | Code: ${otp} | Msg ID: ${info.messageId}`);
        } else {
          console.log(`[OTP Email Sent] Target: ${toEmail} | Msg ID: ${info.messageId}`);
        }
        resolve(info);
      }
    });
  });
}

module.exports = {
  sendOtpEmail
};
