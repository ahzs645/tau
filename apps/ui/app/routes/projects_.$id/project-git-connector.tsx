import { useProject } from '#hooks/use-project.js';
import { GitConnector } from '#components/git/git-connector.js';

export function ProjectGitConnector(): React.ReactNode {
  const { gitRef } = useProject();

  return <GitConnector gitRef={gitRef} className='hidden md:flex' />;
}
