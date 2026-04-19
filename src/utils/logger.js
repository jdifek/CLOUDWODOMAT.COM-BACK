const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  info: (...args) => console.log('[INFO]', new Date().toISOString(), ...args),
  warn: (...args) => console.warn('[WARN]', new Date().toISOString(), ...args),
  error: (...args) => console.error('[ERROR]', new Date().toISOString(), ...args),
  debug: (...args) => isDev && console.log('[DEBUG]', new Date().toISOString(), ...args),
};