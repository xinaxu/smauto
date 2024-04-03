import pino from 'pino'
const logger = pino({
  level: process.env.PINO_LOG_LEVEL || 'debug',
})

export default logger
