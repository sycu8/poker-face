export {};

declare module "react" {
  interface FormHTMLAttributes<T> {
    // T matches React's FormHTMLAttributes type parameter.
    toolname?: T extends Element ? string : string;
    tooldescription?: string;
  }
  interface InputHTMLAttributes<T> {
    // T matches React's InputHTMLAttributes type parameter.
    toolparamdescription?: T extends Element ? string : string;
  }
}
