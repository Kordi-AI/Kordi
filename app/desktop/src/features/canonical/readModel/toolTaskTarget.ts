import type { DesktopChatToolSnapshot } from '@/kordi-app/types';
import { stringValue } from './messageContent';

function safeToolArguments(rawArguments: string) {
  if (!rawArguments.trim()) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function contentTaskTarget(content: Record<string, unknown>) {
  const explicit = stringValue(content.taskTarget)?.trim();
  if (explicit) return explicit;
  const parentSessionKind = stringValue(content.parentSessionKind)?.trim().toLowerCase();
  const parentGroupSpaceId = stringValue(content.parentGroupSpaceId)?.trim();
  const parentSessionTitle = stringValue(content.parentSessionTitle)?.trim();
  if (parentSessionKind === 'group' || parentGroupSpaceId || parentSessionTitle?.startsWith('Group:')) {
    return `Group: ${parentSessionTitle || parentGroupSpaceId || 'Shared session'}`;
  }
  const targetDisplayName = stringValue(content.targetDisplayName)?.trim();
  if (targetDisplayName) return `User: ${targetDisplayName}`;
  return null;
}

function toolHasTaskTarget(tool: DesktopChatToolSnapshot) {
  const args = safeToolArguments(tool.arguments);
  return Boolean(
    stringValue(args.taskTarget)
      || stringValue(args.task_target)
      || stringValue(args.targetAudience)
      || stringValue(args.target_audience)
      || stringValue(args.targetGroup)
      || stringValue(args.target_group)
      || stringValue(args.targetUser)
      || stringValue(args.target_user),
  );
}

export function toolsWithEventTaskTarget(tools: DesktopChatToolSnapshot[], content: Record<string, unknown>) {
  const target = contentTaskTarget(content);
  if (!target) return tools;
  return tools.map((tool) => {
    const name = tool.name.trim().toLowerCase();
    if ((name !== 'task_operator' && name !== 'update_plan') || toolHasTaskTarget(tool)) return tool;
    return {
      ...tool,
      arguments: JSON.stringify({ ...safeToolArguments(tool.arguments), taskTarget: target }),
    };
  });
}
