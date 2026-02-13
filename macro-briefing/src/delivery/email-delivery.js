import nodemailer from 'nodemailer';
import { createLogger } from '../../../shared/index.js';

const logger = createLogger('email-delivery');

/**
 * Send briefing via email. Silently skips if SMTP not configured.
 */
export async function send(report) {
  const host = process.env.SMTP_HOST;
  const recipient = process.env.MACRO_BRIEFING_EMAIL_TO;

  if (!host || !recipient) {
    return 'skipped (SMTP not configured)';
  }

  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  // Simple markdown to HTML conversion
  const html = markdownToHtml(report.fullReport);

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: `Macro Briefing — ${report.date}`,
    text: report.fullReport,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6;">${html}</div>`
  });

  logger.info(`Email sent to ${recipient}`);
  return `emailed to ${recipient}`;
}

/**
 * Minimal markdown → HTML conversion for email
 */
function markdownToHtml(md) {
  return md
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Bullet lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    // Wrap in paragraphs
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}
