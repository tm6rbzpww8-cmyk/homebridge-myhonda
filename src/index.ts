import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { MyHondaPlatform } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, MyHondaPlatform);
};
