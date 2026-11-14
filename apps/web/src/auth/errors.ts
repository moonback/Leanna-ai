const MESSAGES: Record<string, string> = {
  invalid_credentials: 'E-mail ou mot de passe incorrect.',
  user_already_exists: 'Un compte existe déjà avec cet e-mail.',
  email_exists: 'Un compte existe déjà avec cet e-mail.',
  weak_password: 'Mot de passe trop faible : 8 caractères minimum.',
  over_request_rate_limit: 'Trop de tentatives. Réessayez dans quelques minutes.',
  email_not_confirmed: 'Confirmez votre adresse e-mail avant de vous connecter.',
};

export function authErrorMessage(error: { code?: string; message: string }) {
  return (error.code && MESSAGES[error.code]) || 'Une erreur est survenue. Réessayez.';
}
