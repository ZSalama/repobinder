import { Banner } from "@/types";

export function BannerMessage(props: { icon: JSX.Element; text: string; tone: Banner["tone"] }): JSX.Element {
  return (
    <div className={`feedback ${props.tone}`} role={props.tone === "danger" ? "alert" : "status"}>
      {props.icon}
      <span>{props.text}</span>
    </div>
  );
}
