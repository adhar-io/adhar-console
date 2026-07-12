import { StartClient } from '@tanstack/react-start/client'
import { hydrateRoot } from 'react-dom/client'
import { getRouter } from './router.tsx'

const router = await getRouter()

hydrateRoot(document, <StartClient router={router} />)
