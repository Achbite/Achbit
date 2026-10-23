import React from 'react';
import mark from '../../assets/achbit-mark.svg?raw';

const AchbitBrand: React.FC = () => (
  <div className="achbit-gui-brand">
    <span className="achbit-gui-brand__mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: mark }} />
    <span>Achbit</span>
  </div>
);

export default AchbitBrand;
