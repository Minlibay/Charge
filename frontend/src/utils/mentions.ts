const mentionPattern = /(^|[\s>])@([a-zA-Z0-9_.-]+)/g;

export function extractMentionedLogins(content: string): string[] {
  const matches: string[] = [];
  const regex = new RegExp(mentionPattern);
  let result: RegExpExecArray | null;
  while ((result = regex.exec(content)) !== null) {
    const login = result[2]?.toLowerCase();
    if (login && !matches.includes(login)) {
      matches.push(login);
    }
  }
  return matches;
}

export function messageMentionsLogin(content: string, login: string): boolean {
  if (!login) {
    return false;
  }
  const normalized = login.toLowerCase();
  const regex = new RegExp(mentionPattern);
  let result: RegExpExecArray | null;
  while ((result = regex.exec(content)) !== null) {
    if ((result[2] ?? '').toLowerCase() === normalized) {
      return true;
    }
  }
  return false;
}
