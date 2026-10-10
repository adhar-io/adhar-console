import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { bootTheme } from '@adhar/shell-ui/theme'
import { ToastProvider } from '@adhar/shell-ui/toast'
import { router } from './router.tsx'
import './styles.css'

// Same theme boot as the console: saved preset + light/dark/system, with the
// `adhar-theme` cookie shared across *.adhar.io so a dark console visitor
// lands on a dark launch page.
bootTheme()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing from index.html')

createRoot(rootEl).render(
  <ToastProvider>
    <RouterProvider router={router} />
  </ToastProvider>,
)
