import { PrismaClient } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Always resolve DB path relative to project root, not CWD
const envUrl = process.env.DATABASE_URL || 'file:./dev.db'
const relativePath = envUrl.replace(/^file:/, '')
const absolutePath = path.resolve(__dirname, '..', 'prisma', path.basename(relativePath))
const dbUrl = `file:${absolutePath}`

const adapter = new PrismaBetterSqlite3({ url: dbUrl })
const prisma = new PrismaClient({ adapter })

export default prisma
