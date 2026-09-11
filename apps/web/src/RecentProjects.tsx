import { useEffect, useState } from 'react';
import { api } from './api.ts';
type Recent = {
  projectId: string;
  intent: string;
  targetUrl: string;
  jobs: { jobId: string; approvalId: string; status: string }[];
};
export function RecentProjects({
  onResume,
}: {
  onResume: (job: { jobId: string; approvalId: string }) => void;
}) {
  const [projects, setProjects] = useState<Recent[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/projects')
      .then((x) => {
        if (active) setProjects(x.projects);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="recent-projects">
      <h2>내 작업</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : projects.length === 0 ? (
        <p className="small-note">첫 번째 영상이 만들어지면 이곳에서 다시 확인할 수 있어요.</p>
      ) : (
        projects.map((project) => (
          <article key={project.projectId}>
            <div>
              <h3>{project.intent}</h3>
              <p>{project.targetUrl}</p>
            </div>
            {project.jobs.length ? (
              project.jobs.slice(0, 3).map((job) => (
                <button className="secondary" key={job.jobId} onClick={() => onResume(job)}>
                  {job.status === 'succeeded'
                    ? '결과 보기'
                    : ['queued', 'running'].includes(job.status)
                      ? '진행 확인'
                      : '작업 확인'}
                </button>
              ))
            ) : (
              <span className="small-note">아직 생성한 영상이 없습니다.</span>
            )}
          </article>
        ))
      )}
    </section>
  );
}
