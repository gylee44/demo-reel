import { z } from 'zod';
export const LoginTargetSchema = z
  .strictObject({
    strategy: z.enum(['label', 'css', 'testId', 'role']),
    value: z.string().min(1).max(500),
    role: z.enum(['button', 'textbox']).optional(),
  })
  .refine((x) => x.strategy !== 'role' || !!x.role, 'Role is required');
export const LoginProfileSchema = z.strictObject({
  loginUrl: z.url(),
  username: LoginTargetSchema,
  password: LoginTargetSchema,
  submit: LoginTargetSchema,
  successUrl: z.url(),
  successTarget: LoginTargetSchema,
});
export type LoginProfile = z.infer<typeof LoginProfileSchema>;
export const AuthInputSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('form'),
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(200),
    profile: LoginProfileSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('storage_state'),
    verifyUrl: z.url().optional(),
    successTarget: LoginTargetSchema.optional(),
    storageState: z.strictObject({
      cookies: z
        .array(
          z.strictObject({
            name: z.string(),
            value: z.string(),
            domain: z.string(),
            path: z.string(),
            expires: z.number(),
            httpOnly: z.boolean(),
            secure: z.boolean(),
            sameSite: z.enum(['Strict', 'Lax', 'None']),
          }),
        )
        .max(100),
      origins: z
        .array(
          z.strictObject({
            origin: z.url(),
            localStorage: z.array(z.strictObject({ name: z.string(), value: z.string() })).max(100),
          }),
        )
        .max(20),
    }),
  }),
]);
export type AuthInput = z.infer<typeof AuthInputSchema>;
