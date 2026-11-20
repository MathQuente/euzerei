import 'dotenv/config'
import { prisma } from '../database/db'
import { AuditRepository } from '../repositories/audit.repository'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

async function main() {
  const email = readFlag('email')?.trim().toLowerCase()
  if (!email) {
    console.error('Usage: npm run admin:promote -- --email=<email> [--demote]')
    process.exit(1)
  }

  const databaseUrl = new URL(process.env.DATABASE_URL as string)
  if (
    !LOCAL_HOSTS.has(databaseUrl.hostname) &&
    !process.argv.includes('--allow-remote')
  ) {
    console.error(
      `Refusing to run against ${databaseUrl.hostname}. Pass --allow-remote to confirm this is the database you mean.`
    )
    process.exit(1)
  }

  const demote = process.argv.includes('--demote')
  const nextRole = demote ? 'USER' : 'ADMIN'

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, userName: true, role: true }
  })
  if (!user) {
    console.error(`No account with the email ${email}.`)
    process.exit(1)
  }

  if (user.role === nextRole) {
    console.log(`@${user.userName} is already ${nextRole}. Nothing changed.`)
    return
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: nextRole } })
  await new AuditRepository().create({
    actorId: null,
    action: demote ? 'Removeu o papel de admin' : 'Promoveu a conta a admin',
    area: 'SYSTEM',
    target: `@${user.userName}`,
    detail: 'feito pelo script admin:promote'
  })
  console.log(`@${user.userName}: ${user.role} -> ${nextRole}.`)
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
