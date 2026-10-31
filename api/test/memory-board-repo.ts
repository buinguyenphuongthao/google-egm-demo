import type { BoardItem, Project } from '../src/board';
import type { BoardRepo } from '../src/board-repo';

const key = (i: Pick<BoardItem, 'kind' | 'projectId' | 'id'>) => `${i.projectId}/${i.kind}/${i.id}`;

/** In-memory BoardRepo with the same conditional-write behavior as the DynamoDB one. */
export function memoryBoardRepo(): BoardRepo & { projects: Map<string, Project>; items: Map<string, BoardItem> } {
  const projects = new Map<string, Project>();
  const items = new Map<string, BoardItem>();
  return {
    projects,
    items,
    async listProjects() {
      return [...projects.values()];
    },
    async getProject(id) {
      return projects.get(id);
    },
    async createProject(project, columns) {
      projects.set(project.id, project);
      for (const c of columns) items.set(key({ kind: 'column', ...c }), { kind: 'column', ...c });
    },
    async updateProject(project) {
      if (!projects.has(project.id)) return false;
      projects.set(project.id, project);
      return true;
    },
    async deleteProject(id) {
      projects.delete(id);
    },
    async listItems(projectId) {
      return [...items.values()].filter((i) => i.projectId === projectId);
    },
    async createItem(item) {
      if (items.has(key(item))) throw new Error('id collision');
      items.set(key(item), item);
    },
    async updateItem(item) {
      if (!items.has(key(item))) return false;
      items.set(key(item), item);
      return true;
    },
    async deleteItems(list) {
      for (const i of list) items.delete(key(i));
    },
    async ping() {
      return true;
    },
  };
}
