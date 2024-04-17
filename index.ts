import VastAI from './vastai.ts'
import {config} from 'dotenv'
import SessionManager from './manager.ts'
import logger from './logger.ts'
config()

const vastai = new VastAI(process.env.VASTAI_APIKEY!, process.env.COUNTRIES ?? '')
const maxSession = parseInt(process.env.MAX_SESSIONS || '1')
const max3090Price = parseFloat(process.env.MAX_3090_PRICE || '0.24')
const utilizationThreshold = parseFloat(process.env.UTILIZATION_THRESHOLD || '0.55')
const manager = new SessionManager(vastai, maxSession, max3090Price, utilizationThreshold)
try {
  await manager.run()
} catch(e) {
  logger.error(e)
}
