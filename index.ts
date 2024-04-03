import VastAI from './vastai.ts'
import {config} from 'dotenv'
import SessionManager from './manager.ts'
config()

const vastai = new VastAI(process.env.VASTAI_APIKEY!)
const maxSession = parseInt(process.env.MAX_SESSIONS || '1')
const manager = new SessionManager(vastai, maxSession)
await manager.run()
