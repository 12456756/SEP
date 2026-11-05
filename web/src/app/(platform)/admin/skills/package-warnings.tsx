import type { MonitorDetail } from './monitor';

export function SkillPackageWarnings({ warnings }: { warnings: MonitorDetail['packageWarnings'] }) {
  if (!warnings?.length) return null;
  return (
    <section aria-label="技能包提醒" className="min-w-0 space-y-2 border-l-2 border-gwarning pl-3 text-sm text-gtext-secondary">
      <h3 className="font-medium text-gtext-primary">技能包提醒</h3>
      <ul className="max-h-60 space-y-2 overflow-y-auto whitespace-pre-wrap break-all">
        {warnings.map((warning, index) => <li key={`${warning.code}:${warning.path ?? index}`}>{warning.message}</li>)}
      </ul>
    </section>
  );
}
