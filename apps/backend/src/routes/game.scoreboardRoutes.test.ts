import { describe, expect, it, vi } from 'vitest';
import { adminGameRoutes } from './game.js';

type RegisteredRoute = {
  method: string;
  path: string;
  options: { preHandler?: Array<{ roles?: string[] }> };
  handler: unknown;
};

function routeCollector() {
  const routes: RegisteredRoute[] = [];
  const register =
    (method: string) =>
    (
      path: string,
      options: RegisteredRoute['options'],
      handler: unknown,
    ) => {
      routes.push({ method, path, options, handler });
    };
  const authAdmin = vi.fn();
  const app = {
    authAdmin,
    requireAdminRoles: (...roles: string[]) =>
      Object.assign(vi.fn(), { roles }),
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    put: register('PUT'),
    delete: register('DELETE'),
  };
  return { app, routes };
}

function rolesOf(route: RegisteredRoute | undefined) {
  return route?.options.preHandler?.[1]?.roles;
}

describe('运营成绩单路由权限', () => {
  it('审核员只读，只有 SUPER 和 OPERATOR 可以修改、重试与恢复', async () => {
    const { app, routes } = routeCollector();
    await adminGameRoutes(app as never);

    const get = routes.find(
      (route) =>
        route.method === 'GET'
        && route.path === '/api/admin/rounds/:id/scoreboard',
    );
    const patch = routes.find(
      (route) =>
        route.method === 'PATCH'
        && route.path === '/api/admin/rounds/:id/scoreboard',
    );
    const preview = routes.find(
      (route) =>
        route.method === 'POST'
        && route.path === '/api/admin/rounds/:id/scoreboard/preview',
    );
    const sync = routes.find(
      (route) =>
        route.method === 'POST'
        && route.path === '/api/admin/rounds/:id/scoreboard/sync',
    );
    const restore = routes.find(
      (route) =>
        route.method === 'POST'
        && route.path
          === '/api/admin/rounds/:id/scoreboard/revisions/:revision/restore',
    );
    const rounds = routes.find(
      (route) =>
        route.method === 'GET'
        && route.path === '/api/admin/rounds',
    );

    expect(rolesOf(rounds)).toEqual(['SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE']);
    expect(rolesOf(get)).toEqual(['SUPER', 'OPERATOR', 'REVIEWER']);
    expect(rolesOf(preview)).toEqual(['SUPER', 'OPERATOR']);
    expect(rolesOf(patch)).toEqual(['SUPER', 'OPERATOR']);
    expect(rolesOf(sync)).toEqual(['SUPER', 'OPERATOR']);
    expect(rolesOf(restore)).toEqual(['SUPER', 'OPERATOR']);
  });
});
