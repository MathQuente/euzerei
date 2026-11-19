export interface CreateUserDTO {
  email: string
  password: string
  userName?: string
}

export interface AddGameDTO {
  igdbId: number
  userId: string
  statusIds: number
  completedAt?: Date
  endless?: boolean
  /** Só para dar ao jogo a data real em que entrou na lista de origem. */
  createdAt?: Date
}

export interface UpdateUserDTO {
  userName?: string
  profilePicture?: string | null
  userBanner?: string | null
}
