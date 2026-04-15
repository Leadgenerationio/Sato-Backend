import dotenv from 'dotenv';

dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || '3001', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
  DATABASE_URL: process.env.DATABASE_URL || '',
  REDIS_URL: process.env.REDIS_URL || '',
  // Xero OAuth
  XERO_CLIENT_ID: process.env.XERO_CLIENT_ID || '',
  XERO_CLIENT_SECRET: process.env.XERO_CLIENT_SECRET || '',
  XERO_REDIRECT_URI: process.env.XERO_REDIRECT_URI || '',
  XERO_WEBHOOK_KEY: process.env.XERO_WEBHOOK_KEY || '',
};
