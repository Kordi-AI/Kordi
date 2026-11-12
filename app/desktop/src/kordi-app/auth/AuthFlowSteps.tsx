import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AuthFlowStepState = 'pending' | 'active' | 'done';

export type AuthFlowStep = {
  label: string;
  state: AuthFlowStepState;
};

type AuthFlowStepsProps = {
  steps: AuthFlowStep[];
};

function StepDot({ state }: { state: AuthFlowStepState }) {
  if (state === 'done') {
    return (
      <div className="grid h-5 w-5 place-items-center rounded-full bg-[color:var(--app-button-primary-bg)] text-[color:var(--app-button-primary-text)]">
        <Check className="h-3 w-3" />
      </div>
    );
  }

  if (state === 'active') {
    return <div className="h-5 w-5 rounded-full border border-[color:var(--app-control-border)] bg-[color:var(--app-control-active)]" />;
  }

  return <div className="h-5 w-5 rounded-full border border-[color:var(--app-divider)] bg-transparent" />;
}

export function AuthFlowSteps({ steps }: AuthFlowStepsProps) {
  return (
    <div className="app-auth-flow-steps rounded-[22px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-4 py-4">
      <div className="space-y-3">
        {steps.map((step, index) => (
          <div key={`${step.label}-${index}`} className="flex items-start gap-3">
            <div className="mt-0.5 flex flex-col items-center">
              <StepDot state={step.state} />
              {index < steps.length - 1 && <div className="mt-1 h-6 w-px bg-[color:var(--app-divider)]" />}
            </div>
            <div className={cn('text-[13px] leading-6', step.state === 'done' ? 'text-[color:var(--utility-foreground)]' : step.state === 'active' ? 'text-[color:var(--utility-foreground)]' : 'text-[color:var(--utility-meta-text)]')}>
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
