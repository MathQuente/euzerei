import { CloudinaryService } from '../services/cloudinary.service'

/**
 * Apaga no Cloudinary as imagens que o usuário tinha (foto e banner), exceto
 * as que outra conta ainda usa. Melhor esforço: nunca lança, só avisa no log.
 */
export async function destroyOwnedImages(
  urls: (string | null | undefined)[],
  findImageUrlsInUse: (urls: string[]) => Promise<string[]>,
  onError: (error: unknown) => void
): Promise<void> {
  if (!CloudinaryService.isConfigured()) return

  try {
    const candidates = [
      ...new Set(urls.filter((url): url is string => !!url))
    ].filter(url => CloudinaryService.publicIdFromUrl(url) !== null)
    if (candidates.length === 0) return

    const inUse = new Set(await findImageUrlsInUse(candidates))

    for (const url of candidates) {
      if (inUse.has(url)) continue
      try {
        await CloudinaryService.destroy(CloudinaryService.publicIdFromUrl(url)!)
      } catch (error) {
        onError(error)
      }
    }
  } catch (error) {
    onError(error)
  }
}
