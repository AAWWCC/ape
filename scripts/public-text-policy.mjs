// Keep source scanning and public export normalization on the same email policy.
export function allowedEmail(value) {
  if (value.toLowerCase() === 'git@github.com') return true;
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  return ['example.com', 'example.net', 'example.org'].includes(domain)
    || domain.endsWith('.test') || domain.endsWith('.invalid')
    || domain === 'users.noreply.github.com';
}
