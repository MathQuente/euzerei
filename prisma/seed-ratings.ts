import 'dotenv/config'
import bcrypt from 'bcrypt'
import { prisma } from '../src/database/db'
import { getSeedPassword } from '../src/utils/seed-password'

const EMAIL_PREFIX = 'seed-ratings-'
const EMAIL_DOMAIN = '@teste.local'
const BINS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]

interface GamePlan {
  igdbId: number
  counts: number[]
}

const PLANS: GamePlan[] = [
  { igdbId: 62151, counts: [1, 1, 2, 3, 3, 5, 7, 11, 12, 15] },
  { igdbId: 103283, counts: [0, 0, 0, 1, 0, 1, 0, 1, 1, 0] }
]

function ratingsFor(plan: GamePlan): number[] {
  return plan.counts.flatMap((count, i) => Array(count).fill(BINS[i]))
}

async function clean() {
  const result = await prisma.user.deleteMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN } }
  })
  console.log(`Removed ${result.count} users (ratings removed by cascade).`)
}

async function main() {
  if (process.argv.includes('--clean')) {
    await clean()
    return
  }

  const needed = Math.max(...PLANS.map(plan => ratingsFor(plan).length))
  const passwordHash = await bcrypt.hash(getSeedPassword(), 12)

  const users = []
  for (let k = 0; k < needed; k++) {
    const email = `${EMAIL_PREFIX}${k + 1}${EMAIL_DOMAIN}`
    users.push(
      await prisma.user.upsert({
        where: { email },
        update: {},
        create: {
          email,
          userName: `NotaTeste${k + 1}`,
          password: passwordHash,
          emailVerifiedAt: new Date()
        }
      })
    )
  }

  for (const plan of PLANS) {
    const values = ratingsFor(plan)
    for (let i = 0; i < values.length; i++) {
      await prisma.rating.upsert({
        where: { userId_igdbId: { userId: users[i].id, igdbId: plan.igdbId } },
        update: { value: values[i] },
        create: { userId: users[i].id, igdbId: plan.igdbId, value: values[i] }
      })
    }
    console.log(`Game ${plan.igdbId}: ${values.length} ratings`)
  }

  console.log(
    `\nDone: ${users.length} users. Remove with: npx tsx --env-file .env prisma/seed-ratings.ts --clean`
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
