export function buildGoogleAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_OAUTH_CALLBACK_URL!,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent'
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export function buildDiscordAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    redirect_uri: process.env.DISCORD_OAUTH_CALLBACK_URL!,
    response_type: 'code',
    scope: 'identify email',
    state,
    prompt: 'consent'
  })
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`
}
