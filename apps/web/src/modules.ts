import {
  Activity,
  Bell,
  Bot,
  Brain,
  Calendar,
  CheckSquare,
  FileText,
  FolderKanban,
  Globe,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Plug,
  Rocket,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export type AppModule = {
  label: string;
  path: string;
  icon: LucideIcon;
  /** Roadmap phase that delivers it; `null` = available now. */
  phase: number | null;
};

// Only modules with `phase: null` have routes. Others render disabled so no link is dead.
export const MODULES: AppModule[] = [
  { label: 'Dashboard', path: '/', icon: LayoutDashboard, phase: null },
  { label: 'Assistant', path: '/assistant', icon: MessageSquare, phase: null },
  { label: 'Missions', path: '/missions', icon: Rocket, phase: null },
  { label: 'Mémoire', path: '/memory', icon: Brain, phase: null },
  { label: 'Agent Studio', path: '/agents', icon: Bot, phase: null },
  { label: 'Tâches', path: '/tasks', icon: CheckSquare, phase: 7 },
  { label: 'Projets', path: '/projects', icon: FolderKanban, phase: 7 },
  { label: 'Calendrier', path: '/calendar', icon: Calendar, phase: 7 },
  { label: 'Documents', path: '/documents', icon: FileText, phase: 7 },
  { label: 'Email', path: '/email', icon: Mail, phase: 8 },
  { label: 'Automatisations', path: '/automations', icon: Workflow, phase: 8 },
  { label: 'Web Intelligence', path: '/web', icon: Globe, phase: 8 },
  { label: 'Connecteurs', path: '/connectors', icon: Plug, phase: 8 },
  { label: 'Notifications', path: '/notifications', icon: Bell, phase: null },
  { label: 'Activité', path: '/activity', icon: Activity, phase: null },
  { label: 'Paramètres', path: '/settings', icon: Settings, phase: null },
];
