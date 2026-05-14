'use client';

import { authMutationKeys } from '@better-auth-ui/core';
import {
  useAuth,
  useAuthPlugin,
  useFetchOptions,
  useSendVerificationEmail,
  useSignInEmail,
  useSignInUsername,
} from '@better-auth-ui/react';
import type { UsernameAuthClient } from '@better-auth-ui/react';
import { useIsMutating } from '@tanstack/react-query';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { ProviderButtons } from '#components/auth/provider-buttons.js';
import type { SocialLayout } from '#components/auth/provider-buttons.js';
import { Button } from '#components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card.js';
import { Checkbox } from '#components/ui/checkbox.js';
import { Field, FieldDescription, FieldError, FieldGroup, FieldSeparator } from '#components/ui/field.js';
import { Input } from '#components/ui/input.js';
import { Label } from '#components/ui/label.js';
import { Spinner } from '#components/ui/spinner.js';
import { usernamePlugin } from '#utils/username-plugin.js';
import { cn } from '#utils/ui.utils.js';
import { getCaptchaComponentFromPlugins } from '#utils/auth-plugin.js';

export type SignInUsernameProps = {
  className?: string;
  socialLayout?: SocialLayout;
  socialPosition?: 'top' | 'bottom';
};

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Render the username-based sign-in form. Identical to the built-in `<SignIn>`
 * design but routes non-email inputs through `signInUsername` instead of
 * `signInEmail`.
 */
export function SignInUsername({ className, socialLayout, socialPosition = 'bottom' }: SignInUsernameProps) {
  const {
    authClient,
    basePaths,
    baseURL,
    emailAndPassword,
    localization,
    plugins,
    redirectTo,
    socialProviders,
    viewPaths,
    navigate,
    Link,
  } = useAuth();

  const { fetchOptions, resetFetchOptions } = useFetchOptions();

  const { localization: usernameLocalization } = useAuthPlugin(usernamePlugin);

  const [password, setPassword] = useState('');

  const { mutate: sendVerificationEmail } = useSendVerificationEmail(authClient, {
    onSuccess: () => toast.success(localization.auth.verificationEmailSent),
  });

  const { mutate: signInEmail, isPending: isSignInEmailPending } = useSignInEmail(authClient, {
    onError: (error, { email }) => {
      setPassword('');

      if (error.error?.code === 'EMAIL_NOT_VERIFIED') {
        toast.error(error.error?.message ?? error.message, {
          action: {
            label: localization.auth.resend,
            onClick: () => {
              sendVerificationEmail({
                email,
                callbackURL: `${baseURL}${redirectTo}`,
              });
            },
          },
        });
      } else {
        toast.error(error.error?.message ?? error.message);
      }

      resetFetchOptions();
    },
    onSuccess: () => {
      navigate({ to: redirectTo });
    },
  });

  const { mutate: signInUsername, isPending: isSignInUsernamePending } = useSignInUsername(
    authClient as UsernameAuthClient,
    {
      onError: (error) => {
        setPassword('');
        toast.error(error.error?.message ?? error.message);
        resetFetchOptions();
      },
      onSuccess: () => {
        navigate({ to: redirectTo });
      },
    },
  );

  const signInMutating = useIsMutating({
    mutationKey: authMutationKeys.signIn.all,
  });
  const signUpMutating = useIsMutating({
    mutationKey: authMutationKeys.signUp.all,
  });
  const isPending = signInMutating + signUpMutating > 0;
  const isSignInPending = isSignInEmailPending || isSignInUsernamePending;

  const Captcha = getCaptchaComponentFromPlugins(plugins);

  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const rememberMe = formData.get('rememberMe') === 'on';

    if (isEmail(email)) {
      signInEmail({
        email,
        password,
        ...(emailAndPassword?.rememberMe ? { rememberMe } : {}),
        fetchOptions,
      });
    } else {
      signInUsername({
        username: email,
        password,
        ...(emailAndPassword?.rememberMe ? { rememberMe } : {}),
        fetchOptions,
      });
    }
  };

  const showSeparator = emailAndPassword?.enabled && socialProviders && socialProviders.length > 0;

  return (
    <Card className={cn('w-full max-w-sm', className)}>
      <CardHeader>
        <CardTitle className='text-xl font-semibold'>{localization.auth.signIn}</CardTitle>
      </CardHeader>

      <CardContent>
        <div className='flex flex-col gap-6'>
          {socialPosition === 'top' && (
            <>
              {socialProviders && socialProviders.length > 0 && <ProviderButtons socialLayout={socialLayout} />}

              {showSeparator && (
                <FieldSeparator className='m-0 flex items-center text-xs *:data-[slot=field-separator-content]:bg-card'>
                  {localization.auth.or}
                </FieldSeparator>
              )}
            </>
          )}

          {emailAndPassword?.enabled && (
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={Boolean(fieldErrors.email)}>
                  <Label htmlFor='email'>{usernameLocalization.username}</Label>

                  <Input
                    id='email'
                    name='email'
                    type='text'
                    autoComplete='username'
                    placeholder={usernameLocalization.usernameOrEmailPlaceholder}
                    required
                    disabled={isPending}
                    onChange={() => {
                      setFieldErrors((previous) => ({
                        ...previous,
                        email: undefined,
                      }));
                    }}
                    onInvalid={(e) => {
                      e.preventDefault();

                      setFieldErrors((previous) => ({
                        ...previous,
                        email: (e.target as HTMLInputElement).validationMessage,
                      }));
                    }}
                    aria-invalid={Boolean(fieldErrors.email)}
                  />

                  <FieldError>{fieldErrors.email}</FieldError>
                </Field>

                <Field data-invalid={Boolean(fieldErrors.password)}>
                  <Label htmlFor='password'>{localization.auth.password}</Label>

                  <Input
                    id='password'
                    name='password'
                    type='password'
                    autoComplete='current-password'
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);

                      setFieldErrors((previous) => ({
                        ...previous,
                        password: undefined,
                      }));
                    }}
                    placeholder={localization.auth.passwordPlaceholder}
                    required
                    minLength={emailAndPassword?.minPasswordLength}
                    maxLength={emailAndPassword?.maxPasswordLength}
                    disabled={isPending}
                    onInvalid={(e) => {
                      e.preventDefault();

                      setFieldErrors((previous) => ({
                        ...previous,
                        password: (e.target as HTMLInputElement).validationMessage,
                      }));
                    }}
                    aria-invalid={Boolean(fieldErrors.password)}
                  />

                  <FieldError>{fieldErrors.password}</FieldError>
                </Field>

                {emailAndPassword.rememberMe && (
                  <Field className='my-1'>
                    <div className='flex items-center gap-3'>
                      <Checkbox id='rememberMe' name='rememberMe' disabled={isPending} />

                      <Label htmlFor='rememberMe' className='cursor-pointer text-sm font-normal'>
                        {localization.auth.rememberMe}
                      </Label>
                    </div>
                  </Field>
                )}

                {Captcha && <div className='flex justify-center'>{Captcha}</div>}

                <div className='flex flex-col gap-3'>
                  <Button type='submit' disabled={isPending}>
                    {isSignInPending && <Spinner />}

                    {localization.auth.signIn}
                  </Button>

                  {plugins.flatMap((plugin) =>
                    (plugin.authButtons ?? []).map((AuthButton, index) => (
                      <AuthButton key={`${plugin.id}-${index.toString()}`} view='signIn' />
                    )),
                  )}
                </div>
              </FieldGroup>
            </form>
          )}

          {socialPosition === 'bottom' && (
            <>
              {showSeparator && (
                <FieldSeparator className='flex items-center text-xs *:data-[slot=field-separator-content]:bg-card'>
                  {localization.auth.or}
                </FieldSeparator>
              )}

              {socialProviders && socialProviders.length > 0 && <ProviderButtons socialLayout={socialLayout} />}
            </>
          )}
        </div>

        <div className='mt-4 flex w-full flex-col items-center gap-3'>
          {emailAndPassword?.forgotPassword && (
            <Link
              href={`${basePaths.auth}/${viewPaths.auth.forgotPassword}`}
              className='self-center text-sm underline-offset-4 hover:underline'
            >
              {localization.auth.forgotPasswordLink}
            </Link>
          )}

          {emailAndPassword?.enabled && (
            <FieldDescription className='text-center'>
              {localization.auth.needToCreateAnAccount}{' '}
              <Link href={`${basePaths.auth}/${viewPaths.auth.signUp}`} className='underline underline-offset-4'>
                {localization.auth.signUp}
              </Link>
            </FieldDescription>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
