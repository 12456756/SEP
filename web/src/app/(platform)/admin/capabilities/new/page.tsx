'use client';

import { useState } from 'react';
import { ArrowLeft, Workflow } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ContributionCreateDialog } from '@/features/contribution/contribution-create-dialog';
import { SkillForm } from './skill-form';

type CapabilityKind = 'SKILL' | 'RPA';

function SkillIcon({ className = 'h-12 w-12' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="skillGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="url(#skillGradient)" />
      <path
        d="M32 16L16 24v16l16 8 16-8V24L32 16zm0 4l12 6v12l-12 6-12-6V26l12-6z"
        fill="white"
        opacity="0.9"
      />
      <circle cx="32" cy="32" r="4" fill="white" />
    </svg>
  );
}

function PlatformSelector({ selected, onSelect }: { selected: CapabilityKind | null; onSelect: (kind: CapabilityKind) => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <button
        type="button"
        aria-pressed={selected === 'SKILL'}
        onClick={() => onSelect('SKILL')}
        className={`relative rounded-lg border-2 p-6 text-left transition-all ${
          selected === 'SKILL'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30'
        }`}
      >
        <div className="flex items-start gap-4">
          <SkillIcon className="h-12 w-12 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">Skills</h3>
            <p className="mt-1 text-sm text-fg-muted">SKILL.md 技能包，可通过压缩包或本机扫描导入</p>
          </div>
        </div>
        {selected === 'SKILL' && (
          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white" aria-label="已选择">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 010 1.414z" clipRule="evenodd" />
            </svg>
          </span>
        )}
      </button>
      <button
        type="button"
        aria-pressed={selected === 'RPA'}
        onClick={() => onSelect('RPA')}
        className={`relative rounded-lg border-2 p-6 text-left transition-all ${
          selected === 'RPA'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-border bg-card hover:border-primary/50 hover:bg-muted/30'
        }`}
      >
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-amber-400 text-white">
            <Workflow className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">RPA</h3>
            <p className="mt-1 text-sm text-fg-muted">上传自动化流程包，审核通过后供用户下载</p>
          </div>
        </div>
        {selected === 'RPA' && (
          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white" aria-label="已选择">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 010 1.414z" clipRule="evenodd" />
            </svg>
          </span>
        )}
      </button>
    </div>
  );
}

export default function NewCapabilityPage() {
  const [selected, setSelected] = useState<CapabilityKind | null>(null);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/capabilities">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">新建能力</h1>
          <p className="mt-1 text-sm text-fg-muted">选择已开发的能力类型并提交</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. 选择类型</CardTitle>
        </CardHeader>
        <CardContent>
          <PlatformSelector selected={selected} onSelect={setSelected} />
        </CardContent>
      </Card>

      {selected === 'SKILL' && (
        <div className="animate-in slide-in-from-top-4 duration-300">
          <SkillForm onCancel={() => setSelected(null)} />
        </div>
      )}

      <ContributionCreateDialog
        open={selected === 'RPA'}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </div>
  );
}
