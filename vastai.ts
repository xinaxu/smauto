import axios, { AxiosError } from 'axios'
import logger from './logger.ts'
import pRetry, { AbortError } from 'p-retry'

export default class VastAI {
  private static url = 'https://console.vast.ai/api/v0'
  // vastai show ssh-keys
  private static sshKeyID = 37416
  private static script = 'wget https://gist.githubusercontent.com/xinaxu/1b805a488028bacd158119d806654b91/raw/e20809f2e25f9c5ac414bc6c21c782cad7abd4fe/init-gpu.sh; wget https://gist.githubusercontent.com/xinaxu/26d8b16eabb55046230ed6923161ea42/raw/e3d0f306989b1d1752b57a5ef14c2a0d169974ec/init-cpu.sh; chmod +x *.sh; ./init-gpu.sh; ./init-cpu.sh'

  public constructor (
    private readonly apiKey: string,
    private readonly countries: string,
    private readonly type: ('bid' | 'reserved' | 'on-demand')[] = ['on-demand'],
    private readonly reliability: number = 0.95,
    private readonly verified: boolean = false,
    private readonly external: boolean = true,
    private readonly inetUp: number = 400,
    private readonly inetUpCost: number = 0.005,
    private readonly inetDownCost: number = 0.004,
    private readonly tflops: number = 20,
    private readonly storage: number = 8,
  ) {
  }

  private getURL (path: string) {
    return `${VastAI.url}/${path}?api_key=${this.apiKey}`
  }

  public async getInstances (): Promise<{ instances: InstanceDetail[] }> {
    return this.wrap(async () => {
      const response = await axios.get(this.getURL('instances'))
      const data = response.data as { instances: InstanceDetail[] }
      for (let instance of data.instances) {
        if (instance.public_ipaddr) {
          instance.public_ipaddr = instance.public_ipaddr.trim().toLowerCase()
        }
      }
      return data
    })
  }

  public async terminateInstance (id: number): Promise<void> {
    return this.wrap(async () => {
      await axios.delete(this.getURL(`instances/${id}/`))
    })
  }

  public async wrap<T> (fn: () => Promise<T>) {
    return pRetry(async () => {
      try {
        return await fn()
      } catch (error: any) {
        logger.error(`VastAI error: ${error.message}`)
        if (error.message.includes('429') || !(error instanceof AxiosError)) {
          throw error
        }
        throw new AbortError(error.message)
      }
    }, { retries: 3, minTimeout: 10000, maxTimeout: 30000 })
  }

  public async createInstance (id: number): Promise<CreateInstanceResponse> {
    return this.wrap(async () => {
      const url = this.getURL(`asks/${id}/`)
      const data = {
        client_id: 'me',
        image: 'nvidia/opencl:latest',
        disk: this.storage,
        onstart: VastAI.script,
        runtype: 'ssh ssh_direc ssh_proxy',
      }
      const response = await axios.put(url, data)
      return response.data as CreateInstanceResponse
    })
  }

  public async getInstance (instanceID: number): Promise<{ instances: InstanceDetail }> {
    return this.wrap(async () => {
      const response = await axios.get(this.getURL(`instances/${instanceID}`))
      const data = response.data as { instances: InstanceDetail }
      if (data.instances.public_ipaddr) {
        data.instances.public_ipaddr = data.instances.public_ipaddr.trim().toLowerCase()
      }
      return data
    })
  }

  public async getOffers (blockedMachineIDs: number[] = []): Promise<OfferResponse> {
    return this.wrap(async () => {
      const data: any = {
        disk_space: {
          gte: this.storage
        },
        verified: {
          eq: this.verified
        },
        external: {
          eq: this.external
        },
        type: {
          in: this.type
        },
        inet_up: {
          gte: this.inetUp
        },
        inet_up_cost: {
          lte: this.inetUpCost
        },
        inet_down_cost: {
          lte: this.inetDownCost
        },
        total_flops: {
          gte: this.tflops
        },
        rentable: {
          eq: true
        },
        rented: {
          eq: false
        },
        allocated_storage: this.storage,
        order: [
          [
            'flops_per_dphtotal', 'desc'
          ]
        ],
        reliability: {
          gte: this.reliability
        },
        cpu_arch: {
          in: ['amd64']
        },
        machine_id: {
          notin: blockedMachineIDs
        }
      }
      if (this.countries !== '' ) {
        data['geolocation'] = {
          in: this.countries.split(',')
        }
      }
      const response = await axios.post(this.getURL('bundles/'), data)
      return response.data as any
    })
  }
}

export interface OfferResponse {
  offers: Offer[]
}

export interface CreateInstanceResponse {
  success: boolean
  new_contract: number
}

export interface Offer {
  id: number;
  ask_contract_id: number;
  bundle_id: number;
  bundled_results: null;
  bw_nvlink: number;
  compute_cap: number;
  cpu_arch: string;
  cpu_cores: number;
  cpu_cores_effective: number;
  cpu_ghz: number;
  cpu_name: string;
  cpu_ram: number;
  credit_discount_max: number;
  cuda_max_good: number;
  direct_port_count: number;
  disk_bw: number;
  disk_name: string;
  disk_space: number;
  dlperf: number;
  dlperf_per_dphtotal: number;
  dph_base: number;
  dph_total: number;
  driver_version: string;
  driver_vers: number;
  duration: number;
  end_date: number;
  external: null;
  flops_per_dphtotal: number;
  geolocation: string;
  geolocode: number;
  gpu_arch: string;
  gpu_display_active: boolean;
  gpu_frac: number;
  gpu_ids: number[];
  gpu_lanes: number;
  gpu_mem_bw: number;
  gpu_name: string;
  gpu_ram: number;
  gpu_total_ram: number;
  has_avx: number;
  host_id: number;
  hosting_type: number;
  hostname: null;
  inet_down: number;
  inet_down_cost: number;
  inet_up: number;
  inet_up_cost: number;
  is_bid: boolean;
  logo: string;
  machine_id: number;
  min_bid: number;
  mobo_name: string;
  num_gpus: number;
  os_version: string;
  pci_gen: number;
  pcie_bw: number;
  public_ipaddr: string;
  reliability: number;
  reliability_mult: number;
  rentable: boolean;
  rented: boolean;
  score: number;
  start_date: null;
  static_ip: boolean;
  storage_cost: number;
  storage_total_cost: number;
  total_flops: number;
  verification: string;
  vericode: number;
  vram_costperhour: number;
  webpage: null;
  rn: number;
  reliability2: number;
  discount_rate: number;
  discounted_hourly: number;
  discounted_dph_total: number;
}

export interface InstanceDetail {
  is_bid: boolean
  inet_up_billed: any
  inet_down_billed: any
  external: boolean
  webpage: any
  logo: string
  rentable: boolean
  compute_cap: number
  credit_balance: any
  credit_discount: any
  credit_discount_max: number
  driver_version: string
  cuda_max_good: number
  machine_id: number
  hosting_type: any
  public_ipaddr: string
  geolocation: string
  flops_per_dphtotal: number
  dlperf_per_dphtotal: number
  reliability2: number
  host_run_time: number
  client_run_time: number
  host_id: number
  id: number
  bundle_id: number
  num_gpus: number
  total_flops: number
  min_bid: number
  dph_base: number
  dph_total: number
  gpu_name: string
  gpu_ram: number
  gpu_totalram: number
  vram_costperhour: number
  gpu_display_active: boolean
  gpu_mem_bw: number
  bw_nvlink: number
  direct_port_count: number
  gpu_lanes: number
  pcie_bw: number
  pci_gen: number
  dlperf: number
  cpu_name: string
  mobo_name: string
  cpu_ram: number
  cpu_cores: number
  cpu_cores_effective: number
  gpu_frac: number
  has_avx: number
  disk_space: number
  disk_name: string
  disk_bw: number
  inet_up: number
  inet_down: number
  start_date: number
  end_date: any
  duration: any
  storage_cost: number
  inet_up_cost: number
  inet_down_cost: number
  storage_total_cost: number
  os_version: string
  verification: string
  static_ip: boolean
  score: number
  cpu_arch: string
  ssh_idx: string
  ssh_host: string
  ssh_port: number
  actual_status: string
  intended_status: string
  cur_state: string
  next_state: string
  template_hash_id: any
  image_uuid: string
  image_args: any[]
  image_runtype: string
  extra_env: any[]
  onstart: any
  label: any
  jupyter_token: string
  status_msg: string
  gpu_util: any
  disk_util: number
  disk_usage: number
  gpu_temp: any
  local_ipaddrs: string
  direct_port_end: number
  direct_port_start: number
  cpu_util: number
  mem_usage: any
  mem_limit: any
  vmem_usage: any
  machine_dir_ssh_port: number
}
