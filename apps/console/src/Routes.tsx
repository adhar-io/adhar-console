import App from './App';
import AppLayout from './layout/AppLayout';
import ErrorLayout from './layout/ErrorLayout';
import OnboardingLayout from './layout/OnboardingLayout';
import Administrator from './pages/Administrator';
import Define from './pages/Define';
import Deliver from './pages/Deliver';
import Design from './pages/Design';
import Develop from './pages/Develop';
import Discover from './pages/Discover';
import Error from './pages/Error';
import Home from './pages/Home';
import Onboarding from './pages/Onboarding';
import Profile from './pages/Profile';
import Settings from './pages/Settings';

const routes = [
    {
    element: <AppLayout />,
    path: '/',
    children: [
      {
        index: true,
        element: <Home />,
      },
      {
        path: 'define',
        element: <Define />,
        children: [
          {
            path: 'settings',
            element: <Settings />,
          }
        ],
      },
      {
        path: 'design',
        element: <Design />,
        children: [
          {
            index: true,
            element: <AppLayout />,
          },
          {
            path: ':teamId',
            element: <AppLayout />,
          },
          {
            path: ':teamId/edit',
            element: <AppLayout />,
          },
          {
            path: 'new',
            element: <AppLayout />,
          },
        ],
      },
      {
        path: 'develop',
        element: <Develop />,
        children: [
          {
            index: true,
            element: <AppLayout />,
          },
          {
            path: ':teamId',
            element: <AppLayout />,
          },
          {
            path: ':teamId/edit',
            element: <AppLayout />,
          },
          {
            path: 'new',
            element: <AppLayout />,
          },
        ],
      },
      {
        path: 'deliver',
        element: <Deliver />,
        children: [
          {
            index: true,
            element: <AppLayout />,
          },
          {
            path: ':teamId',
            element: <AppLayout />,
          },
          {
            path: ':teamId/edit',
            element: <AppLayout />,
          },
          {
            path: 'new',
            element: <AppLayout />,
          },
        ],
      },
      {
        path: 'discover',
        element: <Discover />,
        children: [
          {
            index: true,
            element: <AppLayout />,
          },
          {
            path: ':teamId',
            element: <AppLayout />,
          },
          {
            path: ':teamId/edit',
            element: <AppLayout />,
          },
          {
            path: 'new',
            element: <AppLayout />,
          },
        ],
      },
      {
        element: <Administrator />,
        path: '/administrator',
      },
      {
        element: <Profile />,
        path: '/profile',
      },
    ],
  },
  {
    element: <OnboardingLayout />,
    children: [
      {
        element: <Onboarding />,
        path: '/signup',
      }
    ],
  },
  {
    element: <ErrorLayout errorCode={404} />,
    children: [
      {
        element: <Error />,
        path: '/not-found',
      },
      {
        element: <Error />,
        path: '/error',
      },
    ],
  },
];

export default routes;