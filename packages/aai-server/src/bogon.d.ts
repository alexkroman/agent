declare module "bogon" {
  interface Bogon {
    (ip: string | Buffer): boolean;
    isBogon: (ip: string | Buffer) => boolean;
    isPrivate: (ip: string | Buffer) => boolean;
    isReserved: (ip: string | Buffer) => boolean;
  }
  const bogon: Bogon;
  export default bogon;
}
