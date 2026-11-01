import { createContext, useContext } from "react";
import type { Project, User } from "./types";
type SessionContext = {
  user: User;
  projects: Project[];
  reloadProjects: () => void;
  reloadUser: () => Promise<void>;
  logout: () => Promise<void>;
};
export const Session = createContext<SessionContext>(null!);
export const ProjectContext = createContext<{
  project: Project;
  reload: () => void;
}>(null!);
export const useSession = () => useContext(Session);
export const useProject = () => useContext(ProjectContext);
