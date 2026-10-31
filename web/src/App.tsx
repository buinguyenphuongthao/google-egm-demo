import { Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { createProject, listProjects, type Project } from './api';
import { BoardView } from './board/BoardView';
import { InlineInput } from './components/InlineInput';
import { Button } from './components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './components/ui/sheet';
import { Sidebar } from './Sidebar';
import { useTheme } from './theme';

// The open project lives in the URL hash, so a reload keeps it.
const hashId = () => decodeURIComponent(window.location.hash.slice(1)) || undefined;

export function App() {
  const [theme, setTheme] = useTheme();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState(hashId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [creatingFirst, setCreatingFirst] = useState(false);

  useEffect(() => {
    listProjects().then(setProjects, () => setLoadFailed(true));
    const onHash = () => setSelectedId(hashId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const active = projects?.find((p) => p.id === selectedId) ?? projects?.[0];

  function select(id: string | undefined) {
    setSelectedId(id);
    setSheetOpen(false);
    history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : window.location.pathname);
  }

  async function create(name: string): Promise<boolean> {
    try {
      const project = await createProject(name);
      setProjects((ps) => [...(ps ?? []), project]);
      select(project.id);
      return true;
    } catch (err) {
      toast.error(`Could not create project: ${err instanceof Error ? err.message : 'something went wrong'}`);
      return false;
    }
  }

  const sidebar = (
    <Sidebar
      projects={projects ?? []}
      activeId={active?.id}
      onSelect={select}
      onCreate={create}
      theme={theme}
      onTheme={setTheme}
    />
  );

  const menuButton = (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open projects">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetTitle className="sr-only">Projects</SheetTitle>
        {sidebar}
      </SheetContent>
    </Sheet>
  );

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-64 shrink-0 border-r md:block">{sidebar}</aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <BoardView
            key={active.id}
            projectId={active.id}
            leading={menuButton}
            onRenamed={(project) => setProjects((ps) => ps && ps.map((p) => (p.id === project.id ? project : p)))}
            onDeleted={(id) => {
              setProjects((ps) => ps && ps.filter((p) => p.id !== id));
              select(undefined);
            }}
          />
        ) : (
          <>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">{menuButton}</header>
            <div className="flex flex-1 items-center justify-center p-4">
              {loadFailed ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  Could not load projects.
                </p>
              ) : projects === null ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : creatingFirst ? (
                <InlineInput
                  className="max-w-xs"
                  label="New project name"
                  placeholder="Project name"
                  maxLength={80}
                  onSubmit={create}
                  onCancel={() => setCreatingFirst(false)}
                />
              ) : (
                <Button onClick={() => setCreatingFirst(true)}>Create your first project</Button>
              )}
            </div>
          </>
        )}
      </main>
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </div>
  );
}
