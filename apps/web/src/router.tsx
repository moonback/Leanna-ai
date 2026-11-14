import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { RequireAuth } from './auth/RequireAuth';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { AssistantPage } from './pages/AssistantPage';
import { MemoryPage } from './pages/MemoryPage';
import { MissionsPage } from './pages/MissionsPage';
import { AgentsPage } from './pages/AgentsPage';
import { ActivityPage, NotificationsPage } from './pages/ActivityPages';
import { LoginPage, SignupPage } from './pages/AuthPages';
import { NotFoundPage } from './pages/NotFoundPage';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'assistant', element: <AssistantPage /> },
          { path: 'assistant/:id', element: <AssistantPage /> },
          { path: 'memory', element: <MemoryPage /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'missions', element: <MissionsPage /> },
          { path: 'missions/:id', element: <MissionsPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
