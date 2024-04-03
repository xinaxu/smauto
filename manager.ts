import type VastAI from './vastai.ts'
import type { InstanceDetail } from './vastai.ts'
import { execa } from 'execa'
import { sleep } from './util.ts'
import fs from 'fs/promises'
import logger from './logger.ts'
import { table } from 'table'
import pRetry from 'p-retry'
import { AxiosError } from 'axios'

export default class SessionManager {
  private blockedMachineIDs: number[] = []
  private sessions: Session[] = []

  constructor (private readonly vastai: VastAI,
    private readonly maxSessions: number = 1,
  ) {}

  public async run () {
    logger.debug('Starting session manager')
    const blockedMachines = await fs.readFile('blocked_machines.txt', {
      encoding: 'utf-8',
      flag: 'a+' // create file if it doesn't exist
    })
    this.blockedMachineIDs = blockedMachines.trim().split(',').map(id => parseInt(id))
    logger.debug(`Blocked machines: ${this.blockedMachineIDs.join(',')}`)
    while (true) {
      await this.updateSessions()
      await this.createNewInstance()
      await this.createTunnels()
      await this.print()
      await sleep(30000)
    }
  }

  private print () {
    const data: string[][] = []
    data.push(['Instance ID', 'Status', 'Host', 'Port', 'GPU', 'Price', 'Tunnel Port', 'SSH PID', 'CPU Usage', 'GPU Usage'])
    for (let session of this.sessions) {
      data.push([
        session.instance.id.toString(),
        session.instance.actual_status,
        session.instance.public_ipaddr,
        session.instance.direct_port_start?.toString(),
        `${session.instance.gpu_name} x ${session.instance.num_gpus}`,
        '$' + session.instance.dph_total?.toFixed(3),
        session.sshTunnel?.tunnelPort.toString() || '',
        session.sshTunnel?.pid.toString() || '',
        session.instance.cpu_util?.toFixed(0) + '%',
        session.instance.gpu_util?.toFixed(0) + '%'
      ])
    }
    console.log(table(data))
  }

  private async addBlockedMachine (id: number) {
    logger.debug(`Blocking machine ${id}`)
    this.blockedMachineIDs.push(id)
    await fs.writeFile('blocked_machines.txt', this.blockedMachineIDs.join(','))
  }

  private async createNewInstance (): Promise<void> {
    if (this.sessions.length >= this.maxSessions) {
      logger.info(`${this.sessions.length} sessions already running, not creating another`)
      return
    }
    const offers = (await this.vastai.getOffers(this.blockedMachineIDs)).offers.filter(offer =>
      offer.gpu_name.includes('4090') ?
        offer.total_flops / offer.dph_total > 82.6 / 0.4 :
        offer.total_flops / offer.dph_total > 35.3 / 0.2)
      .filter(offer => offer.inet_up > 4 * offer.total_flops)
    if (offers.length === 0) {
      logger.warn('No suitable offers found')
      return
    }

    const offer = offers[0]
    logger.info(`Creating instance with offer ${offer.id} - ${offer.gpu_name}x${offer.num_gpus}`)
    try {
      const createResponse = await this.vastai.createInstance(offer.id)
      if (createResponse.success) {
        logger.info(`Instance creation succeeded. New instance: ${createResponse.new_contract}`)
      } else {
        logger.error(`Instance creation failed.`)
        return
      }
    } catch (e: any) {
      if (e.message.includes('410') || e.message.includes('404')) {
        logger.error(e, `Error creating instance, but we'll go ahead`)
        return
      }
      throw e
    }
  }

  private async blockAndTerminate (instance: InstanceDetail) {
    logger.warn(`Blocking and terminating instance ${instance.id}`)
    await this.addBlockedMachine(instance.machine_id)
    await this.vastai.terminateInstance(instance.id)
  }

  private async createTunnels (): Promise<void> {
    for (const session of this.sessions) {
      if (session.sshTunnel) {
        continue
      }
      let failed = false
      try {
        failed = await pRetry(async () => {
          logger.debug(`Checking instance status for ${session.instance.id}`)
          session.instance = (await this.vastai.getInstance(session.instance.id)).instances
          logger.debug(`Instance status: ${session.instance.actual_status}, last msg: ${session.instance.status_msg}`)
          if (session.instance.actual_status === 'running' && session.instance.direct_port_start > 0) {
            return false
          }
          if (session.instance.status_msg?.includes('Error response from daemon') === true
            || session.instance.status_msg?.includes('docker: invalid hostPort') === true) {
            logger.warn(`Instance ${session.instance.id} has an error ${session.instance.status_msg}`)
            return true
          }
          throw new Error(`Instance ${session.instance.id} is not ready. What's going on? ${session.instance.status_msg}`)
        }, {
          retries: 10, minTimeout: 30000, maxTimeout: 30000
        })
      } catch (e) {
        logger.error(e, `Instance ${session.instance.id} is not ready.`)
        await this.blockAndTerminate(session.instance)
        return
      }

      if (failed) {
        await this.blockAndTerminate(session.instance)
        return
      }

      logger.debug(`Check if the instance is reachable and ready for SSH: ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${session.instance.direct_port_start} root@${session.instance.public_ipaddr} 'ps aux'`)
      let stderr = ''
      let stdout = ''
      try {
        await pRetry(async () => {
          const sshResult = await execa(
            'ssh',
            ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-p',
              session.instance.direct_port_start.toString(),
              'root@' + session.instance.public_ipaddr, 'ps aux'],
            { reject: false })
          stderr = sshResult.stderr
          stdout = sshResult.stdout
          if (stdout.includes('-gpuServer')) {
            logger.info(`Instance ${session.instance.id} is ready`)
            return
          }
          throw new Error(`Instance ${session.instance.id} is not ready. What's going on?`)
        }, {
          retries: 3, minTimeout: 30000, maxTimeout: 30000
        })
      } catch (e) {
        logger.warn({ stderr, stdout }, `Instance ${session.instance.id} cannot be connected to.`)
        await this.blockAndTerminate(session.instance)
        return
      }

      logger.debug('Start SSH tunneling')
      let tunnelPort = 0
      for (let i = 10001; i <= this.maxSessions + 10000; ++i) {
        if (this.sessions.some(session => session.sshTunnel?.tunnelPort === i)) {
          continue
        }
        tunnelPort = i
      }
      if (tunnelPort === 0) {
        throw new Error('No available tunnel port')
      }
      logger.info(`Creating tunnel for instance ${session.instance.id} on port ${tunnelPort}`)

      //autossh -f -M 0 -L 10001:localhost:10088 -o "ServerAliveInterval=30" -o "ServerAliveCountMax=3" -p 46661 root@fiber1.kmidata.es
      execa('autossh', ['-f', '-N', '-M', '0', '-L',
        `${tunnelPort}:localhost:10088`,
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=no', '-p',
        session.instance.direct_port_start.toString(),
        `root@${session.instance.public_ipaddr}`])
    }
  }

  private async updateSessions (): Promise<void> {
    const sessions: Session[] = []
    const instances = (await this.vastai.getInstances()).instances
    for (const instance of instances) {
      sessions.push({
        instance
      })
      logger.debug(`Found instance ${instance.id} with status ${instance.actual_status}`)
    }
    logger.info(`Found ${sessions.length} instances`)
    const sshTunnels: SSHTunnel[] = []
    // autossh -f -M 0 -L 10001:localhost:10088 -o "ServerAliveInterval=30" -o "ServerAliveCountMax=3" -p 46661 root@fiber1.kmidata.es
    const { stdout } = await execa('ps', ['-C', 'autossh', '-o', 'pid=,cmd='], { reject: false })
    logger.debug('autossh stdout: \n' + stdout)
    const lines = (stdout as any as string).split('\n')
    for (const line of stdout === '' ? [] : lines) {
      // pid is the first integer in the line
      const match = line.match(/(\d+)/)
      if (!match) {
        throw new Error(`Could not parse line: ${line}`)
      }
      const pid = parseInt(match[0])
      // host is the string after root@
      const hostMatch = line.match(/root@([^ ]+)/)
      if (!hostMatch) {
        throw new Error(`Could not parse host: ${line}`)
      }
      const host = hostMatch[1]
      // remote port is the integer after '-p'
      const remotePortMatch = line.match(/-p (\d+)/)
      if (!remotePortMatch) {
        throw new Error(`Could not parse remote port: ${line}`)
      }
      const remotePort = parseInt(remotePortMatch[1])
      // local port is the integer after '-L'
      const localPortMatch = line.match(/-L (\d+):/)
      if (!localPortMatch) {
        throw new Error(`Could not parse local port: ${line}`)
      }
      const localPort = parseInt(localPortMatch[1])
      logger.info(`Found autossh tunnel with pid ${pid} on port ${localPort} to ${host}:${remotePort}`)
      sshTunnels.push({
        pid,
        tunnelPort: localPort,
        port: remotePort,
        host: host!
      })
    }

    // Terminating tunnels that does not have a corresponding instance
    for (const tunnel of sshTunnels) {
      if (!sessions.find(session => session.instance.public_ipaddr === tunnel.host && session.instance.direct_port_start === tunnel.port)) {
        logger.warn(`Terminating tunnel with pid ${tunnel.pid}`)
        await execa('kill', [tunnel.pid.toString()])
      }
    }

    for (const session of sessions) {
      const tunnel = sshTunnels.find(tunnel => tunnel.host === session.instance.public_ipaddr && tunnel.port === session.instance.direct_port_start)
      if (tunnel) {
        logger.info(`Found tunnel for instance ${session.instance.id} with pid ${tunnel.pid} on port ${tunnel.tunnelPort} to ${tunnel.host}:${tunnel.port}`)
        session.sshTunnel = tunnel
      }
    }

    this.sessions = sessions
  }
}

interface Session {
  instance: InstanceDetail
  sshTunnel?: SSHTunnel
}

interface SSHTunnel {
  pid: number
  tunnelPort: number
  port: number
  host: string
}
