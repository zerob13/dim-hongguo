import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const destination = resolve(root, 'dim/manifest/ui')
await mkdir(destination, { recursive: true })
await cp(resolve(root, 'ui'), destination, { recursive: true, force: true })
await cp(resolve(root, 'icon.svg'), resolve(destination, 'icon.svg'))
console.log('Synced ui/ and icon.svg to dim/manifest/ui; reload the installed plugin to publish a new snapshot.')
