import VastAI from './vastai.ts'
import {config} from 'dotenv'
import SessionManager from './manager.ts'
import logger from './logger.ts'
config()

const vastai = new VastAI(process.env.VASTAI_APIKEY!, process.env.COUNTRIES ?? '')
const maxSession = parseInt(process.env.MAX_SESSIONS || '1')
const manager = new SessionManager(vastai, maxSession)
try {
  await manager.run()
} catch(e) {
  logger.error(e)
}
