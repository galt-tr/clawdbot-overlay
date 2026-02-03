import {PushDrop, Script, Utils} from "@bsv/sdk";
import type {ClawdbotIdentityData, ClawdbotServiceData} from "./types.js";

export function extractPayload (script: Script): ClawdbotIdentityData | ClawdbotServiceData{
    const {fields} = PushDrop.decode(script)
    const jsonBytes = fields[0]
    const payload = JSON.parse(Utils.toUTF8(jsonBytes))
    return payload
}