import { lazy, Suspense, useEffect, useState } from 'react'
import { Landing } from './Landing.tsx'
import { Footer, Header, NotFound, Toasts } from './ui.tsx'

const Workspace = lazy(() => import('./Workspace.tsx'))
const ProjectView = lazy(() => import('./Project.tsx'))
const Statements = lazy(() => import('./Statements.tsx'))
const Docs = lazy(() => import('./Docs.tsx'))
const Settings = lazy(() => import('./Settings.tsx'))

export function usePath() {
  const [path, setPath] = useState(location.pathname + location.search)
  useEffect(() => {
    const onPop = () => setPath(location.pathname + location.search)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  return path
}

function route(full: string) {
  const path = full.split('?')[0].replace(/\/+$/, '') || '/'
  if (path === '/') return { page: 'landing' as const }
  if (path === '/docs') return { page: 'docs' as const }
  if (path === '/settings') return { page: 'settings' as const }
  if (path === '/app') return { page: 'workspace' as const }
  const m = path.match(/^\/app\/p\/([\w-]+)(?:\/([a-z]+))?$/)
  if (m && m[2] === 'statements') return { page: 'statements' as const, id: m[1] }
  if (m) return { page: 'project' as const, id: m[1], tab: m[2] ?? 'overview' }
  return { page: '404' as const }
}

const Loading = () => <div className="boot" role="status"><span className="spinner" /> Loading</div>

export function App() {
  const r = route(usePath())
  useEffect(() => {
    const titles: Record<string, string> = { landing: 'Chargeback: every Snowflake credit, assigned to a team', docs: 'Docs: getting the data out of Snowflake · Chargeback', settings: 'Settings · Chargeback', workspace: 'Projects · Chargeback', '404': 'Not found · Chargeback' }
    if (titles[r.page]) document.title = titles[r.page]
  }, [r.page])
  if (r.page === 'statements') return <Suspense fallback={<Loading />}><Statements id={r.id} /><Toasts /></Suspense>
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<Loading />}>
          {r.page === 'landing' && <Landing />}
          {r.page === 'docs' && <Docs />}
          {r.page === 'settings' && <Settings />}
          {r.page === 'workspace' && <Workspace />}
          {r.page === 'project' && <ProjectView id={r.id} tab={r.tab} />}
          {r.page === '404' && <NotFound />}
        </Suspense>
      </main>
      <Footer />
      <Toasts />
    </>
  )
}
