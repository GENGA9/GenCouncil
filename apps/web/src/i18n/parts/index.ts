// Each part is the dictionary of one area of the console: { en: { 한국어: "English" }, ja: { 한국어: "日本語" } }.
// The Korean text is the key, exactly as it is passed to t().
import knowledge from "./knowledge";
import shared from "./shared";
import vision from "./vision";
import visionMenus from "./vision-menus";
import workshop from "./workshop";

export interface Part {
  en: Record<string, string>;
  ja: Record<string, string>;
}
export const PARTS: Part[] = [shared, workshop, knowledge, vision, visionMenus];
