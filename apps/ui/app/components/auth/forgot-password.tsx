'use client';

import { useAuth, useFetchOptions, useRequestPasswordReset } from '@better-auth-ui/react';
import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '#components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card.js';
import { Field, FieldDescription, FieldError, FieldGroup } from '#components/ui/field.js';
import { Input } from '#components/ui/input.js';
import { Spinner } from '#components/ui/spinner.js';
import { cn } from '#utils/ui.utils.js';
import { getCaptchaComponentFromPlugins } from '#utils/auth-plugin.js';
import { Label } from '#components/ui/label.js';

export type ForgotPasswordProps = {
  className?: string;
};

/**
 * Render a card-based "Forgot Password" form that sends a password-reset email.
 *
 * The form displays an email input, submit button, and a link back to sign-in.
 * Toasts are displayed on success or error via the `useForgotPassword` hook.
 *
 * @param className - Optional additional CSS class names applied to the card
 * @returns The forgot-password form UI as a JSX element
 */
export function ForgotPassword({ className }: ForgotPasswordProps) {
  const { authClient, basePaths, localization, plugins, viewPaths, Link } = useAuth();

  const { fetchOptions, resetFetchOptions } = useFetchOptions();

  const { mutate: requestPasswordReset, isPending } = useRequestPasswordReset(authClient, {
    onError: (error) => {
      toast.error(error.error?.message ?? error.message);
      resetFetchOptions();
    },
    onSuccess: () => toast.success(localization.auth.passwordResetEmailSent),
  });

  function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    requestPasswordReset({
      email: formData.get('email') as string,
      fetchOptions,
    });
  }

  const Captcha = getCaptchaComponentFromPlugins(plugins);

  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
  }>({});

  return (
    <Card className={cn('w-full max-w-sm', className)}>
      <CardHeader>
        <CardTitle className='text-xl font-semibold'>{localization.auth.forgotPassword}</CardTitle>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field data-invalid={Boolean(fieldErrors.email)}>
              <Label htmlFor='email'>{localization.auth.email}</Label>

              <Input
                id='email'
                name='email'
                type='email'
                autoComplete='email'
                placeholder={localization.auth.emailPlaceholder}
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

            {Captcha && <div className='flex justify-center'>{Captcha}</div>}

            <div className='flex flex-col gap-3'>
              <Button type='submit' disabled={isPending}>
                {isPending && <Spinner />}

                {localization.auth.sendResetLink}
              </Button>
            </div>
          </FieldGroup>
        </form>

        <div className='mt-4 flex w-full flex-col items-center gap-3'>
          <FieldDescription className='text-center'>
            {localization.auth.rememberYourPassword}{' '}
            <Link href={`${basePaths.auth}/${viewPaths.auth.signIn}`} className='underline underline-offset-4'>
              {localization.auth.signIn}
            </Link>
          </FieldDescription>
        </div>
      </CardContent>
    </Card>
  );
}
