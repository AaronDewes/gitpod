/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import express from "express";
import { inject, injectable } from "inversify";
import websocket from "ws";

import { User } from "@gitpod/gitpod-protocol";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { AuthJWT } from "./auth/jwt";
import { Config } from "./config";
import { WsNextFunction, WsRequestHandler } from "./express/ws-handler";
import { reportJWTCookieIssued } from "./prometheus-metrics";
import { UserService } from "./user/user-service";
import { JwtPayload } from "jsonwebtoken";

@injectable()
export class SessionHandler {
    static JWT_REFRESH_THRESHOLD = 60 * 60 * 1000; // 1 hour

    @inject(Config) protected readonly config: Config;
    @inject(AuthJWT) protected readonly authJWT: AuthJWT;
    @inject(UserService) protected userService: UserService;

    public jwtSessionConvertor(): express.Handler {
        return async (req, res) => {
            const user = req.user;
            if (!user) {
                res.status(401);
                res.send("User has no valid session.");
                return;
            }

            const cookies = parseCookieHeader(req.headers.cookie || "");
            const jwtToken = cookies[this.getJWTCookieName(this.config)];
            if (!jwtToken) {
                const cookie = await this.createJWTSessionCookie(user.id);

                res.cookie(cookie.name, cookie.value, cookie.opts);

                reportJWTCookieIssued();
                res.status(200);
                res.send("New JWT cookie issued.");
            } else {
                try {
                    // will throw if the token is expired
                    const decoded = await this.authJWT.verify(jwtToken);

                    const issuedAtMs = (decoded.iat || 0) * 1000;
                    const now = new Date();

                    // Was the token issued more than threshold ago?
                    if (issuedAtMs + SessionHandler.JWT_REFRESH_THRESHOLD < now.getTime()) {
                        // issue a new one, to refresh it
                        const cookie = await this.createJWTSessionCookie(user.id);
                        res.cookie(cookie.name, cookie.value, cookie.opts);

                        reportJWTCookieIssued();
                        res.status(200);
                        res.send("Refreshed JWT cookie issued.");
                        return;
                    }

                    res.status(200);
                    res.send("User session already has a valid JWT session.");
                } catch (err) {
                    res.status(401);
                    res.send("JWT Session is invalid");
                    return;
                }
            }
        };
    }

    public http(): express.Handler {
        return (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
            return this.handler(req, next);
        };
    }

    public websocket(): WsRequestHandler {
        return (ws: websocket, req: express.Request, next: WsNextFunction): Promise<void> => {
            return this.handler(req, next);
        };
    }

    // Handler extracts authentication cookies from the incoming request, and
    // resolves a User from it.
    // If succesful, the `req.user` is set with the User which effectively marks the user as authenticated
    // On failure, the next handler is called and the `req.user` is not set. Some APIs/Websocket RPCs do
    // not require authentication, and as such we cannot fail the request at this stage.
    protected async handler(req: express.Request, next: express.NextFunction): Promise<void> {
        const user = await this.verify(req.headers.cookie || "");
        if (user) {
            // We set the user object on the request to signal the user is authenticated.
            // Passport uses the `user` property on the request to determine if the session
            // is authenticated.
            req.user = user;
        }

        next();
    }

    async verify(cookie: string): Promise<User | undefined> {
        try {
            const claims = await this.verifyJWTCookie(cookie);
            if (!claims) {
                return undefined;
            }

            const subject = claims.sub;
            if (!subject) {
                throw new Error("Subject is missing from JWT session claims");
            }

            return await this.userService.findUserById(subject, subject);
        } catch (err) {
            log.warn("Failed to authenticate user with JWT Session", err);
            // Remove the existing cookie, to force the user to re-sing in, and hence refresh it
            return undefined;
        }
    }

    async verifyJWTCookie(cookie: string): Promise<JwtPayload | undefined> {
        const cookies = parseCookieHeader(cookie);
        const jwtToken = cookies[this.getJWTCookieName(this.config)];
        if (!jwtToken) {
            log.debug("No JWT session present on request");
            return undefined;
        }
        const claims = await this.authJWT.verify(jwtToken);
        log.debug("JWT Session token verified", { claims });
        return claims;
    }

    public async createJWTSessionCookie(
        userID: string,
        // only for testing
        options?: {
            issuedAtMs?: number;
            expirySeconds?: number;
        },
    ): Promise<{ name: string; value: string; opts: express.CookieOptions }> {
        const payload = {};
        if (options?.issuedAtMs) {
            Object.assign(payload, { iat: Math.floor(options.issuedAtMs / 1000) });
        }
        const token = await this.authJWT.sign(userID, payload, options?.expirySeconds);

        return {
            name: this.getJWTCookieName(this.config),
            value: token,
            opts: {
                maxAge: this.config.auth.session.cookie.maxAge * 1000, // express does not match the HTTP spec and uses milliseconds
                httpOnly: this.config.auth.session.cookie.httpOnly,
                sameSite: this.config.auth.session.cookie.sameSite,
                secure: this.config.auth.session.cookie.secure,
            },
        };
    }

    private getJWTCookieName(config: Config) {
        return config.auth.session.cookie.name;
    }

    public clearSessionCookie(res: express.Response, config: Config): void {
        res.clearCookie(this.getJWTCookieName(this.config));
    }
}

function parseCookieHeader(cookie: string): { [key: string]: string } {
    return cookie
        .split("; ")
        .map((keypair) => keypair.split("="))
        .reduce<{ [key: string]: string }>((aggregator, vals) => {
            const [key, value] = vals;
            aggregator[key] = value;
            return aggregator;
        }, {});
}
