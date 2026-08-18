'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Banknote,
  Bell,
  BookOpen,
  Building2,
  Calendar,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Landmark,
  LayoutDashboard,
  ListTree,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Percent,
  PieChart,
  ReceiptText,
  Scale,
  ScrollText,
  Trash2,
  Search,
  ShieldCheck,
  Sun,
  Tags,
  Target,
  Wallet,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Avatar, Badge } from '@/components/ui'
import type { NavGroup } from './nav'

// The app chrome: collapsible sidebar + sticky header. Everything here is
// display plumbing — the nav arrives already permission-filtered from the
// server (shell/nav.ts) and mutations go through the server actions passed
// down as props.

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  statements: FileSpreadsheet,
  tagging: Tags,
  cash: Wallet,
  reimbursements: ReceiptText,
  journal: BookOpen,
  bills: FileText,
  invoices: ClipboardList,
  salary: Banknote,
  tasks: CircleCheck,
  reports: PieChart,
  tax: Percent,
  trialBalance: Scale,
  ledgers: Landmark,
  accounts: ListTree,
  costCentres: Target,
  periods: Calendar,
  entities: Building2,
  banking: CreditCard,
  users: ShieldCheck,
  automation: Zap,
  audit: ScrollText,
  bin: Trash2,
}

export interface ShellEntity {
  id: string
  name: string
  code: string
}

export interface ShellNotification {
  title: string
  hint: string
  href: string
  overdue: boolean
}

interface ShellProps {
  nav: NavGroup[]
  user: { name: string; admin: boolean }
  entities: ShellEntity[]
  currentEntityId: string | null
  notifications: ShellNotification[]
  switchAction: (formData: FormData) => Promise<void>
  logoutAction: () => Promise<void>
  children: React.ReactNode
}

const SIDEBAR_KEY = 'ledgerly-sidebar'

export function Shell(props: ShellProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCollapsed(localStorage.getItem(SIDEBAR_KEY) === 'collapsed')
  }, [])
  useEffect(() => setDrawer(false), [pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCollapsed(false)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? 'expanded' : 'collapsed')
      return !c
    })
  }

  const q = query.trim().toLowerCase()
  const groups = q
    ? props.nav
        .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q)) }))
        .filter((g) => g.items.length > 0)
    : props.nav

  const sidebar = (inDrawer: boolean) => (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className={`flex h-16 shrink-0 items-center gap-2.5 ${collapsed && !inDrawer ? 'justify-center px-2' : 'px-5'}`}>
        <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary rounded-lg">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-card">
            <Scale className="size-4" aria-hidden />
          </span>
          {(!collapsed || inDrawer) && (
            <span className="text-[17px] font-semibold tracking-tight text-ink">Ledgerly</span>
          )}
        </Link>
        {inDrawer && (
          <button
            type="button"
            onClick={() => setDrawer(false)}
            className="ml-auto grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Close menu"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Search */}
      {(!collapsed || inDrawer) ? (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input
              ref={inDrawer ? undefined : searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full rounded-xl border border-line bg-surface-2/60 py-2 pl-9 pr-12 text-sm text-ink placeholder:text-ink-3 focus:border-primary focus:bg-surface focus:outline-none"
              aria-label="Search navigation"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
              ⌘K
            </kbd>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => {
              setCollapsed(false)
              localStorage.setItem(SIDEBAR_KEY, 'expanded')
              setTimeout(() => searchRef.current?.focus(), 0)
            }}
            className="grid w-full place-items-center rounded-xl py-2 text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Search"
            title="Search (⌘K)"
          >
            <Search className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Primary">
        {groups.map((g, gi) => (
          <div key={g.title ?? gi} className={gi > 0 ? 'mt-5' : ''}>
            {g.title && (!collapsed || inDrawer) && (
              <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {g.title}
              </p>
            )}
            {g.title && collapsed && !inDrawer && <div className="mx-2 mb-2 border-t border-line" />}
            <ul className="space-y-0.5">
              {g.items.map((item) => {
                const Icon = ICONS[item.icon] ?? LayoutDashboard
                const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(item.href + '/')
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={collapsed && !inDrawer ? item.label : undefined}
                      aria-current={active ? 'page' : undefined}
                      className={`group flex items-center gap-3 rounded-xl px-2.5 py-2 text-[13px] font-medium transition-colors ${
                        collapsed && !inDrawer ? 'justify-center' : ''
                      } ${
                        active
                          ? 'bg-primary-soft text-primary'
                          : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <Icon className={`size-[18px] shrink-0 ${active ? '' : 'text-ink-3 group-hover:text-ink-2'}`} aria-hidden />
                      {(!collapsed || inDrawer) && <span className="truncate">{item.label}</span>}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-2 pt-2 text-xs text-ink-3">Nothing matches “{query}”.</p>
        )}
      </nav>

      {/* Collapse control */}
      {!inDrawer && (
        <div className="border-t border-line p-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-[13px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink ${collapsed ? 'justify-center' : ''}`}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" aria-hidden /> : <PanelLeftClose className="size-[18px]" aria-hidden />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="min-h-screen bg-canvas">
      {/* Desktop sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden border-r border-line bg-surface transition-[width] duration-200 lg:block print:hidden ${
          collapsed ? 'w-[72px]' : 'w-[264px]'
        }`}
      >
        {sidebar(false)}
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden print:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-[280px] animate-fade-up bg-surface shadow-pop">
            {sidebar(true)}
          </div>
        </div>
      )}

      <div className={`transition-[padding] duration-200 print:!pl-0 ${collapsed ? 'lg:pl-[72px]' : 'lg:pl-[264px]'}`}>
        <Header {...props} onMenu={() => setDrawer(true)} pathname={pathname} />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 print:max-w-none">
          {props.children}
        </main>
      </div>
    </div>
  )
}

/* ---------------------------------- Header ---------------------------------- */

function Header(props: ShellProps & { onMenu: () => void; pathname: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-md print:hidden">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={props.onMenu}
          className="grid size-9 place-items-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="size-5" aria-hidden />
        </button>

        <Breadcrumbs nav={props.nav} pathname={props.pathname} />

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {props.entities.length > 0 && (
            <EntitySwitcher
              entities={props.entities}
              currentEntityId={props.currentEntityId}
              switchAction={props.switchAction}
            />
          )}
          {props.user.admin && <Notifications items={props.notifications} />}
          <ThemeToggle />
          <ProfileMenu user={props.user} logoutAction={props.logoutAction} />
        </div>
      </div>
    </header>
  )
}

function Breadcrumbs({ nav, pathname }: { nav: NavGroup[]; pathname: string }) {
  const labelOf = new Map(nav.flatMap((g) => g.items.map((i) => [i.href, i.label] as const)))
  const parts = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string | null }[] = [{ label: 'Home', href: '/' }]
  let path = ''
  for (const part of parts) {
    path += `/${part}`
    const known = labelOf.get(path)
    const label =
      known ??
      (part === 'admin'
        ? 'Admin'
        : part.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()))
    // Only segments that are real nav destinations get links.
    crumbs.push({ label, href: known && path !== pathname ? path : null })
  }
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-[13px] md:flex">
      {crumbs.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />}
          {c.href ? (
            <Link href={c.href} className="truncate text-ink-3 transition-colors hover:text-ink">
              {c.label}
            </Link>
          ) : (
            <span className={`truncate ${i === crumbs.length - 1 ? 'font-medium text-ink' : 'text-ink-3'}`}>
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}

/** Popover scaffolding shared by the header menus: closes on outside click. */
function Popover(props: {
  button: React.ReactNode
  buttonLabel: string
  align?: 'right'
  width?: string
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={props.buttonLabel}
        className="flex items-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {props.button}
      </button>
      {open && (
        <div
          className={`absolute right-0 top-[calc(100%+8px)] z-50 animate-fade-up rounded-2xl border border-line bg-surface p-1.5 shadow-pop ${props.width ?? 'w-64'}`}
        >
          {typeof props.children === 'function' ? props.children(() => setOpen(false)) : props.children}
        </div>
      )}
    </div>
  )
}

function EntitySwitcher(props: {
  entities: ShellEntity[]
  currentEntityId: string | null
  switchAction: (formData: FormData) => Promise<void>
}) {
  const current = props.entities.find((e) => e.id === props.currentEntityId) ?? props.entities[0]
  return (
    <Popover
      buttonLabel="Switch company"
      width="w-72"
      button={
        <span className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3">
          <Building2 className="size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="hidden max-w-[160px] truncate text-[13px] font-medium text-ink sm:block">
            {current.name}
          </span>
          <span className="text-[11px] font-semibold text-ink-3 sm:hidden">{current.code}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        </span>
      }
    >
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            Books of
          </p>
          {props.entities.map((e) => (
            <form key={e.id} action={props.switchAction} onSubmit={close}>
              <input type="hidden" name="entityId" value={e.id} />
              <button
                type="submit"
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${
                  e.id === current.id ? 'font-medium text-primary' : 'text-ink-2'
                }`}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-[10px] font-bold text-ink-2">
                  {e.code.slice(0, 3)}
                </span>
                <span className="truncate">{e.name}</span>
                {e.id === current.id && <CircleCheck className="ml-auto size-4 shrink-0" aria-hidden />}
              </button>
            </form>
          ))}
        </div>
      )}
    </Popover>
  )
}

function Notifications({ items }: { items: ShellNotification[] }) {
  return (
    <Popover
      buttonLabel={`Notifications${items.length ? ` (${items.length})` : ''}`}
      width="w-80"
      button={
        <span className="relative grid size-9 place-items-center">
          <Bell className="size-[18px]" aria-hidden />
          {items.length > 0 && (
            <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-danger text-[9px] font-bold text-white">
              {items.length > 9 ? '9+' : items.length}
            </span>
          )}
        </span>
      }
    >
      <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        Due soon
      </p>
      {items.length === 0 ? (
        <p className="px-3 pb-3 pt-1 text-[13px] text-ink-3">You’re all caught up.</p>
      ) : (
        items.map((n, i) => (
          <Link
            key={i}
            href={n.href}
            className="flex items-start gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-surface-2"
          >
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.overdue ? 'bg-danger' : 'bg-warning'}`} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-ink">{n.title}</span>
              <span className="block text-xs text-ink-3">{n.hint}</span>
            </span>
            {n.overdue && <Badge tone="danger" className="ml-auto mt-0.5">Overdue</Badge>}
          </Link>
        ))
      )}
    </Popover>
  )
}

function ThemeToggle() {
  // The html class is the source of truth (set pre-paint in the root layout);
  // rendering both icons and letting CSS pick avoids any hydration mismatch.
  const toggle = () => {
    const dark = document.documentElement.classList.toggle('dark')
    localStorage.setItem('ledgerly-theme', dark ? 'dark' : 'light')
  }
  return (
    <button
      type="button"
      onClick={toggle}
      className="grid size-9 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      aria-label="Toggle dark mode"
    >
      <Moon className="size-[18px] dark:hidden" aria-hidden />
      <Sun className="hidden size-[18px] dark:block" aria-hidden />
    </button>
  )
}

function ProfileMenu(props: { user: { name: string; admin: boolean }; logoutAction: () => Promise<void> }) {
  return (
    <Popover
      buttonLabel="Account"
      button={
        <span className="flex h-9 items-center gap-2 rounded-xl px-1.5">
          <Avatar name={props.user.name} size="sm" />
          <ChevronDown className="hidden size-3.5 text-ink-3 sm:block" aria-hidden />
        </span>
      }
    >
      <div className="flex items-center gap-3 border-b border-line px-3 pb-3 pt-2">
        <Avatar name={props.user.name} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">{props.user.name}</p>
          <Badge tone={props.user.admin ? 'primary' : 'neutral'} className="mt-0.5">
            {props.user.admin ? 'Admin' : 'Member'}
          </Badge>
        </div>
      </div>
      <form action={props.logoutAction} className="pt-1.5">
        <button
          type="submit"
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </button>
      </form>
    </Popover>
  )
}
