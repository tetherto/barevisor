/// <reference lib="dom" />

import { Duplex, Readable, Writable } from 'streamx'
import ReadyResource from 'ready-resource'

export interface Drive {
  ready(): Promise<void>
  get(key: string): Promise<Buffer | null>
}

export interface ImageOptions {
  name?: string
  keys?: { kernel?: string; initrd?: string }
  cache?: string
  kernel?: string
  initrd?: string
  disk?: string
  cmdline?: string
  agent?: boolean
  agentPort?: number
  network?: boolean
  timeout?: number
}

export interface CpioEntry {
  name: string
  data?: Buffer
  mode?: number
}

export class Image extends ReadyResource {
  constructor(drive?: Drive | null, opts?: ImageOptions)

  readonly drive: Drive | null
  readonly name: string
  readonly cache: string
  readonly dir: string
  readonly keys: { kernel: string; initrd: string }

  kernel: string | null
  initrd: string | null
  disk: string | null
  cmdline: string

  readonly agent: boolean
  readonly agentPort: number
  readonly network: boolean
  readonly timeout: number

  static from(image?: Image | ImageOptions | null): Image

  overlay(): CpioEntry[]
}

export interface AlpineOptions extends ImageOptions {
  version?: string
  arch?: string
  mirror?: string
  drive?: Drive
  packages?: string[]
}

export class Alpine extends Image {
  constructor(opts?: AlpineOptions)

  readonly version: string
  readonly arch: string
  readonly mirror: string
  readonly netboot: string
  readonly packages: string[]

  init(): string
}

export class HttpDrive implements Drive {
  constructor(base: string)

  readonly base: string

  ready(): Promise<void>
  get(key: string): Promise<Buffer | null>
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface ExecResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export interface Mount {
  path: string
  readonly?: boolean
}

export interface VMOptions {
  cpus?: number
  memory?: string | number
  mounts?: Record<string, string | Mount>
  ports?: number[]
  image?: Image | ImageOptions | null
  network?: boolean
  agent?: boolean
  agentPort?: number
  timeout?: number
}

export class VM extends ReadyResource {
  constructor(opts?: VMOptions)

  readonly image: Image
  readonly cpus: number
  readonly memory: number
  readonly mounts: Record<string, Mount>
  readonly ports: number[]
  readonly network: boolean
  readonly agent: boolean
  readonly agentPort: number
  readonly timeout: number

  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  connect(port: number): Duplex
}

export interface Entry {
  key: string
  value: { blob: { byteLength: number } }
}

export interface StreamDriveOptions {
  pool?: PortPool
}

export class PortPool {
  constructor(ports: number[])

  readonly ports: number[]

  acquire(): Promise<number>
  release(port: number): void
}

export class StreamDrive {
  constructor(vm: VM, root: string, opts?: StreamDriveOptions)

  readonly vm: VM
  readonly root: string

  ready(): Promise<void>
  entry(key: string): Promise<Entry | null>
  get(key: string): Promise<Buffer>
  put(key: string, data: Buffer): Promise<void>
  del(key: string): Promise<void>
  list(): AsyncIterable<{ key: string }>
  createReadStream(key: string): Readable
  createWriteStream(key: string): Writable
}

export default class Linux extends VM {
  constructor(opts?: VMOptions & AlpineOptions)
}
