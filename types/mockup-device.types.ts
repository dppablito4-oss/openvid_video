import type { ImageDeviceId } from "./mockup.types";

export interface MockupDeviceState {
    imagePhoneActive: boolean;
    imagePhoneX: number;
    imagePhoneY: number;
    imagePhoneScale: number;
    imagePhoneRotX: number;
    imagePhoneRotY: number;
    imagePhoneRotZ: number;
    imagePhonePerspective: number;
    imagePhoneDevice: ImageDeviceId;
    imagePhonePresetId: string;
    imagePhoneOpening: number;
    imagePhoneShadow: number;
    imagePhoneShadowColor: string;
    imagePhoneRefWidth: number;
}

export const DEFAULT_MOCKUP_DEVICE_STATE: MockupDeviceState = {
    imagePhoneActive: false,
    imagePhoneX: 0,
    imagePhoneY: 0,
    imagePhoneScale: 1,
    imagePhoneRotX: 0,
    imagePhoneRotY: 0,
    imagePhoneRotZ: 0,
    imagePhonePerspective: 600,
    imagePhoneDevice: "phone",
    imagePhonePresetId: "front",
    imagePhoneOpening: 1,
    imagePhoneShadow: 0.6,
    imagePhoneShadowColor: "#000000",
    imagePhoneRefWidth: 0,
};
