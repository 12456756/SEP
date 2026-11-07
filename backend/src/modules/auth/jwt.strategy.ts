import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('ACCESS_JWT_SECRET') ??
        configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    if (payload?.type !== 'access' || typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' || !payload.sid.trim()) {
      return null;
    }
    const user = await this.authService.validateUser(payload.sub, payload.sid);
    return user ? { ...user, sid: payload.sid } : null;
  }
}
