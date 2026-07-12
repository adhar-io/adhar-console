import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { getRouter } from './router.tsx'

export default createStartHandler({ createRouter: getRouter })(defaultStreamHandler)
